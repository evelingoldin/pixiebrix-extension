/*
 * Copyright (C) 2022 PixieBrix, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import {
  InitialValues,
  reduceExtensionPipeline,
} from "@/runtime/reducePipeline";
import {
  IBlock,
  IExtension,
  IExtensionPoint,
  Logger,
  Metadata,
  ReaderOutput,
  ReaderRoot,
  ResolvedExtension,
  Schema,
  UUID,
} from "@/core";
import { propertiesToSchema } from "@/validators/generic";
import {
  CustomEventOptions,
  DebounceOptions,
  ExtensionPoint,
  ExtensionPointConfig,
  ExtensionPointDefinition,
} from "@/extensionPoints/types";
import { Permissions } from "webextension-polyfill";
import {
  castArray,
  cloneDeep,
  compact,
  debounce,
  isEmpty,
  noop,
  stubTrue,
} from "lodash";
import { checkAvailable } from "@/blocks/available";
import reportError from "@/telemetry/reportError";
import { reportEvent } from "@/telemetry/events";
import {
  awaitElementOnce,
  makeShouldRunExtensionForStateChange,
  pickEventProperties,
  selectExtensionContext,
} from "@/extensionPoints/helpers";
import notify from "@/utils/notify";
import { BlockConfig, BlockPipeline } from "@/blocks/types";
import { selectEventData } from "@/telemetry/deployments";
import apiVersionOptions from "@/runtime/apiVersionOptions";
import { blockList } from "@/blocks/util";
import { makeServiceContext } from "@/services/serviceUtils";
import { mergeReaders } from "@/blocks/readers/readerUtils";
import { sleep } from "@/utils";
import initialize from "@/vendors/initialize";
import { $safeFind } from "@/helpers";
import BackgroundLogger from "@/telemetry/BackgroundLogger";
import pluralize from "@/utils/pluralize";
import { PromiseCancelled } from "@/errors/genericErrors";
import { BusinessError } from "@/errors/businessErrors";
import { guessSelectedElement } from "@/utils/selectionController";

export type TriggerConfig = {
  action: BlockPipeline | BlockConfig;
};

export type AttachMode =
  // Attach handlers once (for any elements available at the time of attaching handlers) (default)
  | "once"
  // Watch for new elements and attach triggers to any new elements that matches the selector. Only supports native
  // CSS selectors (because it uses MutationObserver under the hood)
  | "watch";

export type TargetMode =
  // The element that triggered the event
  // https://developer.mozilla.org/en-US/docs/Web/API/EventTarget
  | "eventTarget"
  // The element the trigger is attached to
  | "root";

export type ReportMode =
  // Events (trigger/error) reported only once per extension per page
  | "once"
  // Report all events
  | "all";

export type Trigger =
  // `load` is page load
  | "load"
  // `interval` is a fixed interval
  | "interval"
  // `appear` is triggered when an element enters the user's viewport
  | "appear"
  // `initialize` is triggered when an element is added to the DOM
  | "initialize"
  | "blur"
  | "click"
  | "dblclick"
  | "mouseover"
  | "keydown"
  | "keyup"
  | "keypress"
  | "change"
  // https://developer.mozilla.org/en-US/docs/Web/API/Document/selectionchange_event
  | "selectionchange"
  // The PixieBrix page state changed
  | "statechange"
  // A custom event configured by the user. Can also be an external event from the page
  | "custom";

/**
 * Triggers considered user actions for the purpose of defaulting the reportMode if not provided.
 *
 * Currently, includes mouse events and input blur. Keyboard events, e.g., "keydown", are not included because single
 * key events do not convey user intent.
 *
 * @see ReportMode
 * @see getDefaultReportModeForTrigger
 */
export const USER_ACTION_TRIGGERS: Trigger[] = [
  "click",
  "dblclick",
  "blur",
  "mouseover",
];

type IntervalArgs = {
  /**
   * Interval in milliseconds.
   */
  intervalMillis: number;

  /**
   * Effect to run on each interval.
   */
  effectGenerator: () => Promise<void>;

  /**
   * AbortSignal to cancel the interval
   */
  signal: AbortSignal;

  /**
   * Request an animation frame so that animation effects (e.g., confetti) don't pile up while the user is not
   * using the tab/frame running the interval.
   */
  requestAnimationFrame: boolean;
};

export function getDefaultReportModeForTrigger(trigger: Trigger): ReportMode {
  return USER_ACTION_TRIGGERS.includes(trigger) ? "all" : "once";
}

async function interval({
  intervalMillis,
  effectGenerator,
  signal,
  requestAnimationFrame,
}: IntervalArgs) {
  // Don't run the effect immediately. Wait for the interval first. In the future we might consider adding a "leading"
  // boolean argument to control whether the interval fires immediately
  await sleep(intervalMillis);

  while (!signal.aborted) {
    const start = Date.now();

    try {
      if (requestAnimationFrame) {
        // eslint-disable-next-line no-await-in-loop -- intentionally running in sequence
        await new Promise((resolve) => {
          window.requestAnimationFrame(resolve);
        });
      }

      // eslint-disable-next-line no-await-in-loop -- intentionally running in sequence
      await effectGenerator();
    } catch {
      // NOP
    }

    const sleepDuration = Math.max(0, intervalMillis - (Date.now() - start));

    if (sleepDuration > 0) {
      // Would also be OK to pass 0 to sleep duration
      // eslint-disable-next-line no-await-in-loop -- intentionally running in sequence
      await sleep(sleepDuration);
    }
  }

  console.debug("interval:completed");
}

export abstract class TriggerExtensionPoint extends ExtensionPoint<TriggerConfig> {
  abstract get trigger(): Trigger;

  abstract get attachMode(): AttachMode;

  abstract get intervalMillis(): number;

  abstract get allowBackground(): boolean;

  abstract get targetMode(): TargetMode;

  abstract get reportMode(): ReportMode;

  abstract get debounceOptions(): DebounceOptions;

  abstract get customTriggerOptions(): CustomEventOptions;

  abstract get triggerSelector(): string | null;

  /**
   * Installed DOM event listeners, e.g., `click`
   * @private
   */
  // XXX: does this need to be a set? Shouldn't there only ever be 1 trigger since the trigger is defined on the
  // extension point?
  private readonly installedEvents = new Set<string>();

  /**
   * A bound version of eventHandler
   * @private
   */
  private readonly boundEventHandler: JQuery.EventHandler<unknown>;

  /**
   * Controller to drop all listeners and timers
   * @private
   */
  private abortController = new AbortController();

  // Extensions that have errors/events reported. NOTE: this tracked per contentScript instance. These are not
  // reset on Single Page Application navigation events
  private readonly reportedEvents = new Set<UUID>();
  private readonly reportedErrors = new Set<UUID>();

  /**
   * Run all trigger extensions for all the provided roots.
   * @private
   */
  // Can't set in constructor because the constructor doesn't have access to debounceOptions
  private debouncedRunTriggersAndNotify?: (
    roots: ReaderRoot[],
    {
      nativeEvent,
      shouldRunExtension,
    }: {
      nativeEvent: Event | null;
      shouldRunExtension?: (extension: IExtension) => boolean;
    }
  ) => Promise<void>;

  protected constructor(metadata: Metadata, logger: Logger) {
    super(metadata, logger);

    // Bind so we can pass as callback
    this.boundEventHandler = this.eventHandler.bind(this);
  }

  public get kind(): "trigger" {
    return "trigger";
  }

  private shouldReport(alreadyReported: boolean): boolean {
    switch (this.reportMode) {
      case "once": {
        return !alreadyReported;
      }

      case "all": {
        return true;
      }

      default: {
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- dynamic check for never
        throw new BusinessError(`Invalid reportMode: ${this.reportMode}`);
      }
    }
  }

  private shouldReportError(extensionId: UUID): boolean {
    const alreadyReported = this.reportedErrors.has(extensionId);
    this.reportedErrors.add(extensionId);
    return this.shouldReport(alreadyReported);
  }

  private shouldReportEvent(extensionId: UUID): boolean {
    const alreadyReported = this.reportedEvents.has(extensionId);
    this.reportedEvents.add(extensionId);
    return this.shouldReport(alreadyReported);
  }

  async install(): Promise<boolean> {
    const boundRun = this._runTriggersAndNotify.bind(this);

    this.debouncedRunTriggersAndNotify = this.debounceOptions
      ? debounce(boundRun, this.debounceOptions.waitMillis ?? 0, {
          ...this.debounceOptions,
        })
      : boundRun;

    return this.isAvailable();
  }

  cancelObservers(): void {
    // Inform registered listeners
    this.abortController.abort();

    // Allow new registrations
    this.abortController = new AbortController();
  }

  addCancelHandler(callback: () => void): void {
    this.abortController.signal.addEventListener("abort", callback);
  }

  removeExtensions(): void {
    // NOP: the removeExtensions method doesn't need to unregister anything from the page because the
    // observers/handlers are installed for the extensionPoint itself, not the extensions. I.e., there's a single
    // load/click/etc. trigger that's shared by all extensions using this extension point.
    console.debug("triggerExtension:removeExtensions");
  }

  override uninstall(): void {
    console.debug("triggerExtension:uninstall", {
      id: this.id,
    });

    // Clean up observers
    this.cancelObservers();

    // Find the latest set of DOM elements and uninstall handlers
    if (this.triggerSelector) {
      // NOTE: you might think we could use a WeakSet of HTMLElement to track which elements we've actually attached
      // DOM events too. However, we can't because WeakSet is not an enumerable collection
      // https://esdiscuss.org/topic/removal-of-weakmap-weakset-clear
      const $currentElements = $safeFind(this.triggerSelector);

      console.debug(
        "Removing %s handler from %d element(s)",
        this.trigger,
        $currentElements.length
      );

      if ($currentElements.length > 0) {
        try {
          // This won't impact with other trigger extension points because the handler reference is unique to `this`
          for (const event of this.installedEvents) {
            $currentElements.off(event, this.boundEventHandler);
          }
        } finally {
          this.installedEvents.clear();
        }
      }
    }
  }

  inputSchema: Schema = propertiesToSchema({
    action: {
      $ref: "https://app.pixiebrix.com/schemas/effect#",
    },
  });

  async getBlocks(
    extension: ResolvedExtension<TriggerConfig>
  ): Promise<IBlock[]> {
    return blockList(extension.config.action);
  }

  private async runExtension(
    ctxt: ReaderOutput,
    extension: ResolvedExtension<TriggerConfig>,
    root: ReaderRoot
  ) {
    const extensionLogger = this.logger.childLogger(
      selectExtensionContext(extension)
    );

    const { action: actionConfig } = extension.config;

    const initialValues: InitialValues = {
      input: ctxt,
      root,
      serviceContext: await makeServiceContext(extension.services),
      optionsArgs: extension.optionsArgs,
    };

    // FIXME: https://github.com/pixiebrix/pixiebrix-extension/issues/2910
    try {
      await reduceExtensionPipeline(actionConfig, initialValues, {
        logger: extensionLogger,
        ...apiVersionOptions(extension.apiVersion),
      });
      extensionLogger.info("Successfully ran trigger");
    } catch (error) {
      extensionLogger.error(error);
    }
  }

  /**
   * Shared event handler for DOM event triggers
   * @param event
   */
  private readonly eventHandler: JQuery.EventHandler<unknown> = async (
    event
  ) => {
    console.debug("Handling DOM event", {
      target: event.target,
      event,
    });

    let element: HTMLElement | Document = event.target;

    if (this.trigger === "selectionchange") {
      element = guessSelectedElement() ?? document;
    }

    if (this.targetMode === "root") {
      element = $(event.target).closest(this.triggerSelector).get(0);
      console.debug(
        "Locating closest element for target: %s",
        this.triggerSelector
      );
    }

    await this.debouncedRunTriggersAndNotify([element], {
      nativeEvent: event.originalEvent,
      shouldRunExtension:
        this.trigger === "statechange"
          ? makeShouldRunExtensionForStateChange(event.originalEvent)
          : stubTrue,
    });
  };

  /**
   * Run all extensions for a given root (i.e., handle the trigger firing).
   *
   * DO NOT CALL DIRECTLY: should only be called from runTriggersAndNotify
   *
   * @return array of errors from the extensions
   * @throws Error on non-extension error, e.g., reader error for the default reader
   */
  private async _runTrigger(
    root: ReaderRoot,
    // Force parameter to be included to make it explicit which types of triggers pass nativeEvent
    {
      nativeEvent,
      shouldRunExtension = stubTrue,
    }: {
      nativeEvent: Event | null;
      shouldRunExtension?: (extension: IExtension) => boolean;
    }
  ): Promise<unknown[]> {
    const extensionsToRun = this.extensions.filter((extension) =>
      shouldRunExtension(extension)
    );

    // Don't bother running the reader if no extensions match
    if (extensionsToRun.length === 0) {
      return [];
    }

    const reader = await this.defaultReader();

    const readerContext = {
      // The default reader overrides the event property
      event: nativeEvent ? pickEventProperties(nativeEvent) : null,
      ...(await reader.read(root)),
    };

    const errors = await Promise.all(
      extensionsToRun.map(async (extension) => {
        const extensionLogger = this.logger.childLogger(
          selectExtensionContext(extension)
        );
        try {
          await this.runExtension(readerContext, extension, root);
        } catch (error) {
          if (this.shouldReportError(extension.id)) {
            reportError(error, extensionLogger.context);
          }

          return error;
        }

        if (this.shouldReportEvent(extension.id)) {
          reportEvent("TriggerRun", selectEventData(extension));
        }
      })
    );
    return compact(errors);
  }

  /**
   * DO NOT CALL DIRECTLY: should call debouncedRunTriggersAndNotify.
   */
  private async _runTriggersAndNotify(
    roots: ReaderRoot[],
    // Force parameter to be included to make it explicit which types of triggers pass nativeEvent
    { nativeEvent }: { nativeEvent: Event | null }
  ): Promise<void> {
    const promises = roots.map(async (root) =>
      this._runTrigger(root, { nativeEvent })
    );
    const results = await Promise.allSettled(promises);
    const errors = results.flatMap((x) =>
      // `runTrigger` fulfills with list of extension error from extension, or rejects on other error, e.g., reader
      // error from the extension point.
      x.status === "fulfilled" ? x.value : x.reason
    );

    TriggerExtensionPoint.notifyErrors(errors);
  }

  /**
   * Show notification for errors to the user. Caller is responsible for sending error telemetry.
   * @param errors
   */
  static notifyErrors(errors: unknown[]): void {
    if (errors.length === 0) {
      return;
    }

    const subject = pluralize(errors.length, "a trigger", "$$ triggers");
    const message = `An error occurred running ${subject}`;
    console.debug(message, { errors });
    notify.error({
      message,
      reportError: false,
    });
  }

  private async getRoot(): Promise<JQuery<HTMLElement | Document>> {
    const rootSelector = this.triggerSelector;

    // Await for the element(s) to appear on the page so that we can
    const [rootPromise, cancelRun] = isEmpty(rootSelector)
      ? [document, noop]
      : awaitElementOnce(rootSelector);

    this.addCancelHandler(cancelRun);

    try {
      await rootPromise;
    } catch (error) {
      if (error instanceof PromiseCancelled) {
        return;
      }

      throw error;
    }

    // AwaitElementOnce doesn't work with multiple elements. Get everything that's on the current page
    const $root = isEmpty(rootSelector) ? $(document) : $safeFind(rootSelector);

    if ($root.length === 0) {
      console.warn("No elements found for trigger selector: %s", rootSelector);
    }

    return $root;
  }

  private attachInterval() {
    this.cancelObservers();

    if (this.intervalMillis > 0) {
      this.logger.debug("Attaching interval trigger");

      const intervalEffect = async () => {
        const $root = await this.getRoot();
        await this.debouncedRunTriggersAndNotify([...$root], {
          nativeEvent: null,
        });
      };

      void interval({
        intervalMillis: this.intervalMillis,
        effectGenerator: intervalEffect,
        signal: this.abortController.signal,
        requestAnimationFrame: !this.allowBackground,
      });

      console.debug("triggerExtension:attachInterval", {
        intervalMillis: this.intervalMillis,
      });
    } else {
      this.logger.warn(
        "Skipping interval trigger because interval is not greater than zero"
      );
    }
  }

  private attachInitializeTrigger(
    $element: JQuery<Document | HTMLElement>
  ): void {
    this.cancelObservers();

    // The caller will have already waited for the element. So $element will contain at least one element
    if (this.attachMode === "once") {
      void this.debouncedRunTriggersAndNotify([...$element], {
        nativeEvent: null,
      });
      return;
    }

    const observer = initialize(
      this.triggerSelector,
      (index, element: HTMLElement) => {
        void this.debouncedRunTriggersAndNotify([element], {
          nativeEvent: null,
        });
      },
      // `target` is a required option
      { target: document }
    );

    this.addCancelHandler(() => {
      observer.disconnect();
    });
  }

  private attachAppearTrigger($element: JQuery): void {
    this.cancelObservers();

    // https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
    const appearObserver = new IntersectionObserver(
      (entries) => {
        const roots = entries
          .filter((x) => x.isIntersecting)
          .map((x) => x.target as HTMLElement);
        void this.debouncedRunTriggersAndNotify(roots, { nativeEvent: null });
      },
      {
        root: null,
        // RootMargin: "0px",
        threshold: 0.2,
      }
    );

    for (const element of $element) {
      appearObserver.observe(element);
    }

    if (this.attachMode === "watch") {
      const selector = this.triggerSelector;

      console.debug("Watching selector: %s", selector);
      const mutationObserver = initialize(
        selector,
        (index, element) => {
          console.debug("initialize: %s", selector);
          appearObserver.observe(element);
        },
        // `target` is a required option
        { target: document }
      );
      this.addCancelHandler(() => {
        mutationObserver.disconnect();
      });
    }

    this.addCancelHandler(() => {
      appearObserver.disconnect();
    });
  }

  private attachDocumentTrigger(): void {
    const $document = $(document);

    $document.off(this.trigger, this.boundEventHandler);

    // Install the DOM trigger
    $document.on(this.trigger, this.boundEventHandler);

    this.installedEvents.add(this.trigger);

    this.addCancelHandler(() => {
      $document.off(this.trigger, this.boundEventHandler);
    });
  }

  private attachDOMTrigger(
    $element: JQuery<HTMLElement | Document>,
    { watch = false }: { watch?: boolean }
  ): void {
    const domTrigger =
      this.trigger === "custom"
        ? this.customTriggerOptions?.eventName
        : this.trigger;

    if (!domTrigger) {
      throw new BusinessError(
        "No trigger event configured for extension point"
      );
    }

    // Avoid duplicate events caused by:
    // 1) Navigation events on SPAs where the element remains on the page
    // 2) `watch` mode, because the observer will fire the existing elements on the page. (That re-fire will have
    //  watch: false, see observer handler below.)
    console.debug(
      "Removing existing %s handler for extension point",
      this.trigger
    );
    $element.off(domTrigger, this.boundEventHandler);

    // Install the DOM trigger
    $element.on(domTrigger, this.boundEventHandler);
    this.installedEvents.add(domTrigger);
    console.debug(
      "Installed %s event handler on %d elements",
      domTrigger,
      $element.length,
      {
        trigger: domTrigger,
        selector: this.triggerSelector,
        targetMode: this.targetMode,
        watch,
      }
    );

    if (watch) {
      if ($element.get(0) === document) {
        console.warn("Ignoring watchMode for document target");
        return;
      }

      // Clear out the existing mutation observer on SPA navigation events.
      // On mutation events, this watch branch is not executed because the mutation handler below passes `watch: false`
      this.cancelObservers();

      // Watch for new elements on the page
      const mutationObserver = initialize(
        this.triggerSelector,
        (index, element) => {
          // Already watching, so don't re-watch on the recursive call
          this.attachDOMTrigger($(element as HTMLElement), { watch: false });
        },
        // `target` is a required option
        { target: document }
      );
      this.addCancelHandler(() => {
        mutationObserver.disconnect();
      });
    }
  }

  private assertElement(
    $root: JQuery<HTMLElement | Document>
  ): asserts $root is JQuery {
    if ($root.get(0) === document) {
      throw new Error(`Trigger ${this.trigger} requires a selector`);
    }
  }

  async run(): Promise<void> {
    this.cancelObservers();

    const $root = await this.getRoot();

    switch (this.trigger) {
      case "load": {
        await this.debouncedRunTriggersAndNotify([...$root], {
          nativeEvent: null,
        });
        break;
      }

      case "interval": {
        this.attachInterval();
        break;
      }

      case "initialize": {
        this.attachInitializeTrigger($root);
        break;
      }

      case "appear": {
        this.assertElement($root);
        this.attachAppearTrigger($root);
        break;
      }

      case "selectionchange": {
        this.attachDocumentTrigger();
        break;
      }

      case "statechange": {
        this.attachDocumentTrigger();
        break;
      }

      case "custom": {
        this.attachDOMTrigger($root, { watch: false });
        break;
      }

      default: {
        if (this.trigger) {
          this.assertElement($root);
          this.attachDOMTrigger($root, { watch: this.attachMode === "watch" });
        } else {
          throw new BusinessError(
            "No trigger event configured for extension point"
          );
        }
      }
    }
  }
}

type TriggerDefinitionOptions = Record<string, string>;

export interface TriggerDefinition extends ExtensionPointDefinition {
  defaultOptions?: TriggerDefinitionOptions;

  /**
   * The selector for the element to watch for the trigger.
   *
   * Ignored for the page `load` trigger.
   */
  rootSelector?: string;

  /**
   * - `once` (default) to attach handler once to all elements when `rootSelector` becomes available.
   * - `watch` to attach handlers to new elements that match the selector
   * @since 1.4.7
   */
  attachMode?: AttachMode;

  /**
   * Allow triggers to run in the background, even when the tab is not active. Currently, only checked for intervals.
   * @since 1.5.3
   */
  background: boolean;

  /**
   * Flag to control if all trigger fires/errors for an extension are reported.
   *
   * If not provided, defaults based on the trigger type:
   * - User action (e.g., click): all
   * - Automatic actions: once
   *
   * @see ReportMode
   * @see USER_ACTION_TRIGGERS
   * @since 1.6.4
   */
  reportMode?: ReportMode;

  /**
   * @since 1.4.8
   */
  targetMode?: TargetMode;

  /**
   * The trigger event
   */
  trigger?: Trigger;

  /**
   * For `interval` trigger, the interval in milliseconds.
   */
  intervalMillis?: number;

  /**
   * For `custom` trigger, the custom event trigger options.
   *
   * @since 1.6.5
   */
  customEvent?: CustomEventOptions;

  /**
   * Debounce the trigger for the extension point.
   */
  debounce?: DebounceOptions;
}

class RemoteTriggerExtensionPoint extends TriggerExtensionPoint {
  private readonly _definition: TriggerDefinition;

  public readonly permissions: Permissions.Permissions;

  public readonly rawConfig: ExtensionPointConfig<TriggerDefinition>;

  public override get defaultOptions(): Record<string, string> {
    return this._definition.defaultOptions ?? {};
  }

  constructor(config: ExtensionPointConfig<TriggerDefinition>) {
    // `cloneDeep` to ensure we have an isolated copy (since proxies could get revoked)
    const cloned = cloneDeep(config);
    super(cloned.metadata, new BackgroundLogger());
    this._definition = cloned.definition;
    this.rawConfig = cloned;
    const { isAvailable } = cloned.definition;
    this.permissions = {
      permissions: ["tabs", "webNavigation"],
      origins: castArray(isAvailable.matchPatterns),
    };
  }

  get debounceOptions(): DebounceOptions | null {
    return this._definition.debounce;
  }

  get customTriggerOptions(): CustomEventOptions | null {
    return this._definition.customEvent;
  }

  get trigger(): Trigger {
    return this._definition.trigger ?? "load";
  }

  get targetMode(): TargetMode {
    return this._definition.targetMode ?? "eventTarget";
  }

  get attachMode(): AttachMode {
    return this._definition.attachMode ?? "once";
  }

  get reportMode(): ReportMode {
    return (
      this._definition.reportMode ??
      getDefaultReportModeForTrigger(this.trigger)
    );
  }

  get intervalMillis(): number {
    return this._definition.intervalMillis ?? 0;
  }

  get triggerSelector(): string | null {
    return this._definition.rootSelector;
  }

  get allowBackground(): boolean {
    return this._definition.background ?? false;
  }

  override async defaultReader() {
    return mergeReaders(this._definition.reader);
  }

  async isAvailable(): Promise<boolean> {
    return checkAvailable(this._definition.isAvailable);
  }
}

export function fromJS(
  config: ExtensionPointConfig<TriggerDefinition>
): IExtensionPoint {
  const { type } = config.definition;
  if (type !== "trigger") {
    throw new Error(`Expected type=trigger, got ${type}`);
  }

  return new RemoteTriggerExtensionPoint(config);
}

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

import React, { useCallback, useState } from "react";
import pTimeout from "p-timeout";
import { navigationEvent } from "@/pageEditor/events";
import { FrameworkMeta } from "@/messaging/constants";
import { getErrorMessage, isErrorObject } from "@/errors/errorHelpers";
import reportError from "@/telemetry/reportError";
import { uuidv4 } from "@/types/helpers";
import { useTabEventListener } from "@/hooks/events";
import { thisTab } from "@/pageEditor/utils";
import { detectFrameworks } from "@/contentScript/messenger/api";
import { ensureContentScript } from "@/background/messenger/api";
import { canAccessTab } from "webext-tools";
import { sleep } from "@/utils";
import { useAsyncState } from "@/hooks/common";
import { onContextInvalidated } from "@/errors/contextInvalidated";

interface FrameMeta {
  frameworks: FrameworkMeta[];
}

export interface FrameConnectionState {
  frameId: number;

  /**
   * UUID for the navigation result
   */
  navSequence: string | undefined;

  /**
   * True if the devtools have permission to access the current tab
   */
  hasPermissions: boolean;

  meta: FrameMeta | undefined;
}

const initialFrameState: FrameConnectionState = {
  navSequence: undefined,
  hasPermissions: false,
  meta: undefined,
  frameId: 0,
};

export type Context = {
  /**
   * True if a connection attempt is in process
   */
  connecting: boolean;

  /**
   * The frame connection state, or initialFrameState if there was an error
   */
  tabState: FrameConnectionState;

  /**
   * The error connecting to the frame, or undefined.
   * @see connectToFrame
   */
  error?: unknown;
};

const initialValue: Context = {
  connecting: false,
  tabState: initialFrameState,
};

export const PageEditorTabContext = React.createContext(initialValue);

async function connectToFrame(): Promise<FrameConnectionState> {
  const uuid = uuidv4();
  const common = { ...initialFrameState, navSequence: uuid };

  console.debug(`connectToFrame: connecting for ${uuid}`);
  if (!(await canAccessTab(thisTab))) {
    console.debug("connectToFrame: cannot access tab");
    return common;
  }

  console.debug("connectToFrame: ensuring contentScript");
  const firstTimeout = Symbol("firstTimeout");
  const contentScript = ensureContentScript(thisTab, 15_000);
  const result = await Promise.race([
    sleep(4000).then(() => firstTimeout),
    contentScript,
  ]);

  if (result === firstTimeout) {
    throw new Error(
      "The Page Editor could not establish a connection to the page, retrying…"
    );
  }

  try {
    await contentScript;
  } catch (error) {
    const errorMessage =
      isErrorObject(error) && error.name === "TimeoutError"
        ? "The Page Editor could not establish a connection to the page"
        : getErrorMessage(error);
    reportError(error);
    throw new Error(errorMessage, { cause: error });
  }

  let frameworks: FrameworkMeta[] = [];
  try {
    console.debug("connectToFrame: detecting frameworks");
    frameworks = await pTimeout(detectFrameworks(thisTab, null), {
      milliseconds: 500,
    });
  } catch (error) {
    console.debug("connectToFrame: error detecting frameworks", {
      error,
    });
  }

  console.debug(`connectToFrame: replacing tabState for ${uuid}`);
  return {
    ...common,
    hasPermissions: true,
    meta: { frameworks },
  };
}

export function useDevConnection(): Context {
  const { tabId } = browser.devtools.inspectedWindow;

  const [contextInvalidatedError] = useAsyncState<Error>(async () => {
    await onContextInvalidated();
    return new Error(
      "The connection to the PixieBrix browser extension was lost. Reload the Page Editor."
    );
  });

  const [lastUpdate, setLastUpdate] = useState(Date.now());

  const connect = useCallback(async () => {
    setLastUpdate(Date.now());
  }, []);

  // Automatically connect on load
  const [tabState, isConnecting, connectionError] = useAsyncState(
    connectToFrame,
    [lastUpdate],
    initialFrameState
  );
  useTabEventListener(tabId, navigationEvent, connect);

  return {
    connecting: isConnecting,
    error: contextInvalidatedError ?? connectionError,
    // `tabState` will be if null there's an error in useAsyncState. The caller is responsible for checking the
    // connecting/error properties.
    tabState: tabState ?? initialFrameState,
  };
}

/*
 * Copyright (C) 2021 PixieBrix, Inc.
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

import { useToasts, Options as ToastOptions } from "react-toast-notifications";
import { useCallback, useMemo } from "react";
import { reportError } from "@/telemetry/logging";
import { getErrorMessage } from "@/errors";
import { reportEvent } from "@/telemetry/events";

interface NotificationOptions {
  /**
   * If provided, reports an event via telemetry
   */
  event?: string;
}

interface ErrorNotificationOptions extends NotificationOptions {
  /**
   * True to report the error to Rollbar.
   */
  report?: boolean;

  /**
   * True to autoDismiss the notification.
   */
  autoDismiss?: boolean;

  /**
   * If provided, this error will be provided to Rollbar instead of
   */
  error?: unknown;
}

type Notifications = {
  success: (content: string, options?: NotificationOptions) => void;
  info: (content: string) => void;
  warning: (content: string, options?: ErrorNotificationOptions) => void;
  error: (content: unknown, options?: ErrorNotificationOptions) => void;

  /**
   * Show an error indicating a user error, i.e., as opposed to an application error.
   *
   * If the user is filling out a form, you should use form validation instead of showing a userError on submit.
   */
  userError: (content: string, options?: ErrorNotificationOptions) => void;
};

/**
 * A hook that simplifies reporting notifications to users and telemetry
 */
function useNotifications(): Notifications {
  const { addToast } = useToasts();

  const notifySuccess = useCallback(
    (content: string, options: NotificationOptions = {}) => {
      const { event } = options;
      if (event) {
        reportEvent(event);
      }

      addToast(content, {
        appearance: "success",
        autoDismiss: true,
      });
    },
    [addToast]
  );

  const notifyInfo = useCallback(
    (content: string) => {
      addToast(content, {
        appearance: "info",
        autoDismiss: true,
      });
    },
    [addToast]
  );

  const notify = useCallback(
    (
      content: string,
      {
        report,
        error,
        event,
        autoDismiss,
        appearance,
      }: ErrorNotificationOptions & ToastOptions
    ) => {
      if (report) {
        reportError(error ?? content);
      }

      if (event) {
        reportEvent(event);
      }

      addToast(content, {
        appearance,
        autoDismiss,
      });
    },
    [addToast]
  );

  const notifyWarning = useCallback(
    (content: string, options: ErrorNotificationOptions = {}) => {
      notify(content, {
        report: false,
        autoDismiss: true,
        ...options,
      });
    },
    [notify]
  );

  const notifyError = useCallback(
    (content: unknown, options: ErrorNotificationOptions = {}) => {
      notify(getErrorMessage(content ?? "Unknown Error"), {
        report: true,
        autoDismiss: true,
        ...options,
      });
    },
    [notify]
  );

  const notifyUserError = useCallback(
    (content: string, options: ErrorNotificationOptions = {}) => {
      notify(content, {
        report: false,
        autoDismiss: true,
        ...options,
      });
    },
    [notify]
  );

  // Memoize the object so callers can use root value in the dependency
  return useMemo(
    () => ({
      error: notifyError,
      info: notifyInfo,
      success: notifySuccess,
      warning: notifyWarning,
      userError: notifyUserError,
    }),
    [notifyError, notifyInfo, notifyWarning, notifySuccess, notifyUserError]
  );
}

export default useNotifications;
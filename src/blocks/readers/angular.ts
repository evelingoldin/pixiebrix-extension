/*
 * Copyright (C) 2020 Pixie Brix, LLC
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { createSendScriptMessage } from "@/messaging/chrome";
import { READ_ANGULAR_SCOPE } from "@/messaging/constants";
import { ReaderOutput } from "@/core";
import { registerFactory } from "@/blocks/readers/factory";

export interface AngularConfig {
  type: "angular";
  selector: string;
}

export const withAngularScope = createSendScriptMessage<ReaderOutput>(
  READ_ANGULAR_SCOPE
);

async function doRead(reader: AngularConfig): Promise<ReaderOutput> {
  const { selector } = reader;
  return await withAngularScope({
    selector,
  });
}

registerFactory("angular", doRead);

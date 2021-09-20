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

/* eslint-disable security/detect-object-injection */
import { Field, useField } from "formik";
import React, { ChangeEvent, useEffect, useState } from "react";
import styles from "./FieldEditor.module.scss";
import { RJSFSchema, SetActiveField } from "./formBuilderTypes";
import { Row, Form as BootstrapForm, Col } from "react-bootstrap";
import { UI_ORDER, UI_WIDGET } from "./schemaFieldNames";
import {
  FIELD_TYPE_OPTIONS,
  parseUiType,
  replaceStringInArray,
  stringifyUiType,
} from "./formBuilderHelpers";
import { Schema } from "@/core";
import ConnectedFieldTemplate from "@/components/form/ConnectedFieldTemplate";
import FieldTemplate from "@/components/form/FieldTemplate";
import { produce } from "immer";
import SelectWidget from "@/components/form/widgets/SelectWidget";

const FieldEditor: React.FC<{
  name: string;
  propertyName: string;
  setActiveField: SetActiveField;
}> = ({ name, propertyName, setActiveField }) => {
  const [
    { value: rjsfSchema },
    ,
    { setValue: setRjsfSchema },
  ] = useField<RJSFSchema>(name);
  const { schema } = rjsfSchema;
  const [{ value: propertySchema }] = useField(
    `${name}.schema.properties.${propertyName}`
  );
  const [{ value: propertyUiSchema }] = useField(
    `${name}.uiSchema.${propertyName}`
  );

  const [propertyNameError, setPropertyNameError] = useState<string>(null);
  useEffect(() => {
    setPropertyNameError(null);
  }, [propertyName, schema]);

  const getFullFieldName = (fieldName: string) =>
    `${name}.schema.properties.${propertyName}.${fieldName}`;

  const onPropertyNameChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextName = event.target.value;

    // Validation
    if (nextName === "") {
      setPropertyNameError("Name cannot be empty.");
      return;
    }

    if (nextName.includes(".")) {
      setPropertyNameError("Name must not contain periods.");
      return;
    }

    const existingProperties = Object.keys(schema.properties);
    if (existingProperties.includes(nextName)) {
      setPropertyNameError(
        `Name must be unique. Another property "${
          (schema.properties[nextName] as Schema).title
        }" already has the name "${nextName}".`
      );
      return;
    }

    if (propertyNameError) {
      setPropertyNameError(null);
    }

    const nextRjsfSchema = produce(rjsfSchema, (draft) => {
      draft.schema.properties[nextName] = draft.schema.properties[propertyName];
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete draft.schema.properties[propertyName];

      const nextUiOrder = replaceStringInArray(
        draft.uiSchema[UI_ORDER],
        propertyName,
        nextName
      );
      draft.uiSchema[UI_ORDER] = nextUiOrder;
    });
    setRjsfSchema(nextRjsfSchema);
    setActiveField(nextName);
  };

  const onUiTypeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { value } = event.target;
    if (!value) {
      return;
    }

    const { propertyType, uiWidget, propertyFormat } = parseUiType(value);
    const nextRjsfSchema = produce(rjsfSchema, (draft) => {
      (draft.schema.properties[propertyName] as Schema).type = propertyType;

      if (propertyFormat) {
        (draft.schema.properties[
          propertyName
        ] as Schema).format = propertyFormat;
      } else {
        delete (draft.schema.properties[propertyName] as Schema).format;
      }

      if (uiWidget) {
        if (!draft.uiSchema[propertyName]) {
          draft.uiSchema[propertyName] = {};
        }

        draft.uiSchema[propertyName][UI_WIDGET] = uiWidget;
      } else if (draft.uiSchema[propertyName]) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete draft.uiSchema[propertyName][UI_WIDGET];
      }
    });

    setRjsfSchema(nextRjsfSchema);
  };

  const getSelectedUiTypeOption = () => {
    const propertyType = propertySchema.type;
    const uiWidget = propertyUiSchema ? propertyUiSchema[UI_WIDGET] : undefined;
    const propertyFormat = propertySchema.format;

    const uiType = stringifyUiType({
      propertyType,
      uiWidget,
      propertyFormat,
    });

    const selected = FIELD_TYPE_OPTIONS.find(
      (option) => option.value === uiType
    );

    return selected === null
      ? {
          label: "unknown",
          value: null,
        }
      : selected;
  };

  return (
    <div className={styles.active}>
      <FieldTemplate
        required
        name={`${name}.${propertyName}`}
        label="Name"
        value={propertyName}
        onChange={onPropertyNameChange}
        touched
        error={propertyNameError}
      />
      <ConnectedFieldTemplate name={getFullFieldName("title")} label="Label" />
      <ConnectedFieldTemplate
        name={getFullFieldName("description")}
        label="Help text"
      />
      <ConnectedFieldTemplate
        name={getFullFieldName("default")}
        label="Default value"
      />

      <FieldTemplate
        name={getFullFieldName("uiType")}
        label="Type"
        as={SelectWidget}
        options={FIELD_TYPE_OPTIONS}
        value={getSelectedUiTypeOption().value}
        onChange={onUiTypeChange}
      />

      <BootstrapForm.Group as={Row}>
        <BootstrapForm.Label column sm="3">
          Required
        </BootstrapForm.Label>
        <Col sm="9" className={styles.fieldColumn}>
          <Field
            type="checkbox"
            name={`${name}.schema.required`}
            value={propertyName}
          />
        </Col>
      </BootstrapForm.Group>
    </div>
  );
};

export default FieldEditor;
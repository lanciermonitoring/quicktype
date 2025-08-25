import type { Name } from "../../Naming";
import { type Sourcelike, modifySource } from "../../Source";
import { camelCase, utf16StringEscape } from "../../support/Strings";
import type { ClassType, EnumType, Type } from "../../Type";
import { isNamedType } from "../../Type/TypeUtils";
import type { JavaScriptTypeAnnotations } from "../JavaScript";

import { TypeScriptFlowBaseRenderer } from "./TypeScriptFlowBaseRenderer";
import { tsFlowTypeAnnotations } from "./utils";

export class TypeScriptRenderer extends TypeScriptFlowBaseRenderer {
    protected forbiddenNamesForGlobalNamespace(): string[] {
        return ["Array", "Date"];
    }

    protected deserializerFunctionLine(t: Type, name: Name): Sourcelike {
        const jsonType =
            this._tsFlowOptions.rawType === "json" ? "string" : "any";
        return [
            "public static to",
            name,
            "(json: ",
            jsonType,
            "): ",
            this.sourceFor(t).source,
        ];
    }

    protected serializerFunctionLine(t: Type, name: Name): Sourcelike {
        const camelCaseName = modifySource(camelCase, name);
        const returnType =
            this._tsFlowOptions.rawType === "json" ? "string" : "any";
        return [
            "public static ",
            camelCaseName,
            "ToJson(value: ",
            this.sourceFor(t).source,
            "): ",
            returnType,
        ];
    }

    protected get moduleLine(): string | undefined {
        return "export class Convert";
    }

    protected get typeAnnotations(): JavaScriptTypeAnnotations {
        return Object.assign({ never: ": never" }, tsFlowTypeAnnotations);
    }

    protected emitModuleExports(): void {
        return;
    }

    protected emitUsageImportComment(): void {
        const topLevelNames: Sourcelike[] = [];
        this.forEachTopLevel(
            "none",
            (_t, name) => {
                topLevelNames.push(", ", name);
            },
            isNamedType,
        );
        this.emitLine(
            "//   import { Convert",
            topLevelNames,
            ' } from "./file";',
        );
    }

    protected emitEnum(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));

        // enums with only one value are emitted as constants
        if (this._tsFlowOptions.preferConstValues && e.cases.size === 1) return;

        // For mixed enums or when preferUnions is true, emit as union type
        if (this._tsFlowOptions.preferUnions || e.isMixed) {
            let items = "";
            e.cases.forEach((item) => {
                const literal = typeof item === "string" 
                    ? `"${utf16StringEscape(item)}"` 
                    : String(item);
                if (items === "") {
                    items += literal;
                    return;
                }

                items += ` | ${literal}`;
            });
            this.emitLine("export type ", enumName, " = ", items, ";");
        } else {
            // Pure string/number/boolean enum - can use TypeScript enum
            this.emitBlock(["export enum ", enumName, " "], "", () => {
                this.forEachEnumCase(e, "none", (name, value) => {
                    const literal = typeof value === "string"
                        ? `"${utf16StringEscape(value)}"`
                        : String(value);
                    this.emitLine(name, ` = ${literal},`);
                });
            });
        }
    }

    protected emitClassBlock(c: ClassType, className: Name): void {
        this.emitBlock(
            this._tsFlowOptions.preferTypes
                ? ["export type ", className, " = "]
                : ["export interface ", className, " "],
            "",
            () => {
                this.emitClassBlockBody(c);
            },
        );
    }
}

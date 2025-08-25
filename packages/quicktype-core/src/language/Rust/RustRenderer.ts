/* eslint-disable @typescript-eslint/naming-convention */
import { mapFirst } from "collection-utils";

import {
    anyTypeIssueAnnotation,
    nullTypeIssueAnnotation,
} from "../../Annotation";
import {
    ConvenienceRenderer,
    type ForbiddenWordsInfo,
} from "../../ConvenienceRenderer";
import type { Name, Namer } from "../../Naming";
import type { RenderContext } from "../../Renderer";
import type { OptionValues } from "../../RendererOptions";
import { type Sourcelike, maybeAnnotated } from "../../Source";
import { defined } from "../../support/Support";
import type { TargetLanguage } from "../../TargetLanguage";
import {
    type ClassType,
    type EnumType,
    type Type,
    UnionType,
} from "../../Type";
import {
    matchType,
    nullableFromUnion,
    removeNullFromUnion,
} from "../../Type/TypeUtils";

import { keywords } from "./constants";
import type { rustOptions } from "./language";
import {
    Density,
    type NamingStyleKey,
    Visibility,
    camelNamingFunction,
    getPreferredNamingStyle,
    listMatchingNamingStyles,
    nameWithNamingStyle,
    namingStyles,
    rustStringEscape,
    snakeNamingFunction,
} from "./utils";

export class RustRenderer extends ConvenienceRenderer {
    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof rustOptions>,
    ) {
        super(targetLanguage, renderContext);
    }

    protected makeNamedTypeNamer(): Namer {
        return camelNamingFunction;
    }

    protected namerForObjectProperty(): Namer | null {
        return snakeNamingFunction;
    }

    protected makeUnionMemberNamer(): Namer | null {
        return camelNamingFunction;
    }

    protected makeEnumCaseNamer(): Namer | null {
        return camelNamingFunction;
    }

    protected forbiddenNamesForGlobalNamespace(): readonly string[] {
        return keywords;
    }

    protected forbiddenForObjectProperties(
        _c: ClassType,
        _className: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForUnionMembers(
        _u: UnionType,
        _unionName: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForEnumCases(
        _e: EnumType,
        _enumName: Name,
    ): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected get commentLineStart(): string {
        return "/// ";
    }

    private nullableRustType(t: Type, withIssues: boolean): Sourcelike {
        return ["Option<", this.breakCycle(t, withIssues), ">"];
    }

    protected isImplicitCycleBreaker(t: Type): boolean {
        const kind = t.kind;
        return kind === "array" || kind === "map";
    }

    private rustType(t: Type, withIssues = false): Sourcelike {
        return matchType<Sourcelike>(
            t,
            (_anyType) =>
                maybeAnnotated(
                    withIssues,
                    anyTypeIssueAnnotation,
                    "Option<serde_json::Value>",
                ),
            (_nullType) =>
                maybeAnnotated(
                    withIssues,
                    nullTypeIssueAnnotation,
                    "Option<serde_json::Value>",
                ),
            (_boolType) => "bool",
            (_integerType) => "i64",
            (_doubleType) => "f64",
            (_stringType) => "String",
            (arrayType) => [
                "Vec<",
                this.rustType(arrayType.items, withIssues),
                ">",
            ],
            (classType) => this.nameForNamedType(classType),
            (mapType) => [
                "HashMap<String, ",
                this.rustType(mapType.values, withIssues),
                ">",
            ],
            (enumType) => this.nameForNamedType(enumType),
            (unionType) => {
                const nullable = nullableFromUnion(unionType);

                if (nullable !== null)
                    return this.nullableRustType(nullable, withIssues);

                const [hasNull] = removeNullFromUnion(unionType);

                const isCycleBreaker = this.isCycleBreakerType(unionType);

                const name = isCycleBreaker
                    ? ["Box<", this.nameForNamedType(unionType), ">"]
                    : this.nameForNamedType(unionType);

                return hasNull !== null
                    ? (["Option<", name, ">"] as Sourcelike)
                    : name;
            },
        );
    }

    private breakCycle(t: Type, withIssues: boolean): Sourcelike {
        const rustType = this.rustType(t, withIssues);
        const isCycleBreaker = this.isCycleBreakerType(t);

        return isCycleBreaker ? ["Box<", rustType, ">"] : rustType;
    }

    private emitRenameAttribute(
        propName: Name,
        jsonName: string,
        defaultNamingStyle: NamingStyleKey,
        preferedNamingStyle: NamingStyleKey,
    ): void {
        const escapedName = rustStringEscape(jsonName);
        const name = namingStyles[defaultNamingStyle].fromParts(
            this.sourcelikeToString(propName).split(" "),
        );
        const styledName = nameWithNamingStyle(name, preferedNamingStyle);
        const namesDiffer = escapedName !== styledName;
        if (namesDiffer) {
            this.emitLine('#[serde(rename = "', escapedName, '")]');
        }
    }

    private emitSkipSerializeNone(t: Type): void {
        if (t instanceof UnionType) {
            const nullable = nullableFromUnion(t);
            if (nullable !== null)
                this.emitLine(
                    '#[serde(skip_serializing_if = "Option::is_none")]',
                );
        }
    }

    private get visibility(): string {
        if (this._options.visibility === Visibility.Crate) {
            return "pub(crate) ";
        }
        if (this._options.visibility === Visibility.Public) {
            return "pub ";
        }

        return "";
    }

    protected emitStructDefinition(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));
        this.emitLine(
            "#[derive(",
            this._options.deriveDebug ? "Debug, " : "",
            this._options.deriveClone ? "Clone, " : "",
            this._options.derivePartialEq ? "PartialEq, " : "",
            "Serialize, Deserialize)]",
        );

        // List the possible naming styles for every class property
        const propertiesNamingStyles: { [key: string]: string[] } = {};
        this.forEachClassProperty(c, "none", (_name, jsonName, _prop) => {
            propertiesNamingStyles[jsonName] =
                listMatchingNamingStyles(jsonName);
        });

        // Set the default naming style on the struct
        const defaultStyle = "snake_case";
        const preferedNamingStyle = getPreferredNamingStyle(
            Object.values(propertiesNamingStyles).flat(),
            defaultStyle,
        );
        if (preferedNamingStyle !== defaultStyle) {
            this.emitLine(`#[serde(rename_all = "${preferedNamingStyle}")]`);
        }

        const blankLines =
            this._options.density === Density.Dense ? "none" : "interposing";
        const structBody = (): void =>
            this.forEachClassProperty(c, blankLines, (name, jsonName, prop) => {
                this.emitDescription(
                    this.descriptionForClassProperty(c, jsonName),
                );
                this.emitRenameAttribute(
                    name,
                    jsonName,
                    defaultStyle,
                    preferedNamingStyle,
                );
                if (this._options.skipSerializingNone) {
                    this.emitSkipSerializeNone(prop.type);
                }

                this.emitLine(
                    this.visibility,
                    name,
                    ": ",
                    this.breakCycle(prop.type, true),
                    ",",
                );
            });

        this.emitBlock(["pub struct ", className], structBody);
    }

    protected emitBlock(line: Sourcelike, f: () => void): void {
        this.emitLine(line, " {");
        this.indent(f);
        this.emitLine("}");
    }

    protected emitUnion(u: UnionType, unionName: Name): void {
        const isMaybeWithSingleType = nullableFromUnion(u);

        if (isMaybeWithSingleType !== null) {
            return;
        }

        this.emitDescription(this.descriptionForType(u));
        this.emitLine(
            "#[derive(",
            this._options.deriveDebug ? "Debug, " : "",
            this._options.deriveClone ? "Clone, " : "",
            this._options.derivePartialEq ? "PartialEq, " : "",
            "Serialize, Deserialize)]",
        );
        this.emitLine("#[serde(untagged)]");

        const [, nonNulls] = removeNullFromUnion(u);

        const blankLines =
            this._options.density === Density.Dense ? "none" : "interposing";
        this.emitBlock(["pub enum ", unionName], () =>
            this.forEachUnionMember(
                u,
                nonNulls,
                blankLines,
                null,
                (fieldName, t) => {
                    const rustType = this.breakCycle(t, true);
                    this.emitLine([fieldName, "(", rustType, "),"]);
                },
            ),
        );
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));
        
        // For mixed enums, use custom serde serialization
        if (e.isMixed) {
            this.emitLine(
                "#[derive(",
                this._options.deriveDebug ? "Debug, " : "",
                this._options.deriveClone ? "Clone, " : "",
                this._options.derivePartialEq ? "PartialEq, " : "",
                ")]",
            );
            
            const blankLines = this._options.density === Density.Dense ? "none" : "interposing";
            this.emitBlock(["pub enum ", enumName], () => {
                this.forEachEnumCase(e, blankLines, (name, _value) => {
                    this.emitLine([name, ","]);
                });
            });
            
            // Emit custom Serialize implementation
            this.ensureBlankLine();
            this.emitLine("impl Serialize for ", enumName, " {");
            this.indent(() => {
                this.emitLine("fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>");
                this.emitLine("where");
                this.indent(() => {
                    this.emitLine("S: serde::Serializer,");
                });
                this.emitLine("{");
                this.indent(() => {
                    this.emitLine("match self {");
                    this.indent(() => {
                        this.forEachEnumCase(e, "none", (name, value) => {
                            if (typeof value === "string") {
                                this.emitLine(enumName, "::", name, " => serializer.serialize_str(\"", rustStringEscape(value), "\"),");
                            } else if (typeof value === "number") {
                                if (Number.isInteger(value)) {
                                    this.emitLine(enumName, "::", name, " => serializer.serialize_i64(", String(value), "),");
                                } else {
                                    this.emitLine(enumName, "::", name, " => serializer.serialize_f64(", String(value), "),");
                                }
                            } else if (typeof value === "boolean") {
                                this.emitLine(enumName, "::", name, " => serializer.serialize_bool(", String(value), "),");
                            }
                        });
                    });
                    this.emitLine("}");
                });
                this.emitLine("}");
            });
            this.emitLine("}");
            
            // Emit custom Deserialize implementation
            this.ensureBlankLine();
            this.emitLine("impl<'de> serde::Deserialize<'de> for ", enumName, " {");
            this.indent(() => {
                this.emitLine("fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>");
                this.emitLine("where");
                this.indent(() => {
                    this.emitLine("D: serde::Deserializer<'de>,");
                });
                this.emitLine("{");
                this.indent(() => {
                    this.emitLine("struct ", enumName, "Visitor;");
                    this.ensureBlankLine();
                    
                    this.emitLine("impl<'de> serde::de::Visitor<'de> for ", enumName, "Visitor {");
                    this.indent(() => {
                        this.emitLine("type Value = ", enumName, ";");
                        this.ensureBlankLine();
                        
                        this.emitLine("fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {");
                        this.indent(() => {
                            this.emitLine("formatter.write_str(\"a valid ", enumName, " value\")");
                        });
                        this.emitLine("}");
                        this.ensureBlankLine();
                        
                        // Add visit methods for each type we expect
                        const hasString = Array.from(e.cases).some(v => typeof v === "string");
                        const hasNumber = Array.from(e.cases).some(v => typeof v === "number");
                        const hasBoolean = Array.from(e.cases).some(v => typeof v === "boolean");
                        
                        if (hasString) {
                            this.emitLine("fn visit_str<E>(self, value: &str) -> Result<", enumName, ", E>");
                            this.emitLine("where");
                            this.indent(() => {
                                this.emitLine("E: serde::de::Error,");
                            });
                            this.emitLine("{");
                            this.indent(() => {
                                this.emitLine("match value {");
                                this.indent(() => {
                                    this.forEachEnumCase(e, "none", (name, caseValue) => {
                                        if (typeof caseValue === "string") {
                                            this.emitLine("\"", rustStringEscape(caseValue), "\" => Ok(", enumName, "::", name, "),");
                                        }
                                    });
                                    this.emitLine("_ => Err(E::unknown_variant(value, &[\"", 
                                        Array.from(e.cases).filter(v => typeof v === "string")
                                            .map(v => rustStringEscape(v as string)).join("\", \""), 
                                        "\"])),");
                                });
                                this.emitLine("}");
                            });
                            this.emitLine("}");
                            this.ensureBlankLine();
                        }
                        
                        if (hasNumber) {
                            this.emitLine("fn visit_i64<E>(self, value: i64) -> Result<", enumName, ", E>");
                            this.emitLine("where");
                            this.indent(() => {
                                this.emitLine("E: serde::de::Error,");
                            });
                            this.emitLine("{");
                            this.indent(() => {
                                this.emitLine("match value {");
                                this.indent(() => {
                                    this.forEachEnumCase(e, "none", (name, caseValue) => {
                                        if (typeof caseValue === "number" && Number.isInteger(caseValue)) {
                                            this.emitLine(String(caseValue), " => Ok(", enumName, "::", name, "),");
                                        }
                                    });
                                    this.emitLine("_ => Err(E::invalid_value(serde::de::Unexpected::Signed(value), &self)),");
                                });
                                this.emitLine("}");
                            });
                            this.emitLine("}");
                            this.ensureBlankLine();
                            
                            this.emitLine("fn visit_f64<E>(self, value: f64) -> Result<", enumName, ", E>");
                            this.emitLine("where");
                            this.indent(() => {
                                this.emitLine("E: serde::de::Error,");
                            });
                            this.emitLine("{");
                            this.indent(() => {
                                this.emitLine("match value {");
                                this.indent(() => {
                                    this.forEachEnumCase(e, "none", (name, caseValue) => {
                                        if (typeof caseValue === "number") {
                                            this.emitLine("v if v == ", String(caseValue), " => Ok(", enumName, "::", name, "),");
                                        }
                                    });
                                    this.emitLine("_ => Err(E::invalid_value(serde::de::Unexpected::Float(value), &self)),");
                                });
                                this.emitLine("}");
                            });
                            this.emitLine("}");
                            this.ensureBlankLine();
                        }
                        
                        if (hasBoolean) {
                            this.emitLine("fn visit_bool<E>(self, value: bool) -> Result<", enumName, ", E>");
                            this.emitLine("where");
                            this.indent(() => {
                                this.emitLine("E: serde::de::Error,");
                            });
                            this.emitLine("{");
                            this.indent(() => {
                                this.emitLine("match value {");
                                this.indent(() => {
                                    this.forEachEnumCase(e, "none", (name, caseValue) => {
                                        if (typeof caseValue === "boolean") {
                                            this.emitLine(String(caseValue), " => Ok(", enumName, "::", name, "),");
                                        }
                                    });
                                    this.emitLine("_ => Err(E::invalid_value(serde::de::Unexpected::Bool(value), &self)),");
                                });
                                this.emitLine("}");
                            });
                            this.emitLine("}");
                            this.ensureBlankLine();
                        }
                    });
                    this.emitLine("}");
                    this.ensureBlankLine();
                    
                    this.emitLine("deserializer.deserialize_any(", enumName, "Visitor)");
                });
                this.emitLine("}");
            });
            this.emitLine("}");
            return;
        }

        // For pure number/boolean enums, use custom serialization like mixed enums
        // Only pure string enums can use standard serde derives
        if (e.valueType === "string") {
            this.emitLine(
                "#[derive(",
                this._options.deriveDebug ? "Debug, " : "",
                this._options.deriveClone ? "Clone, " : "",
                this._options.derivePartialEq ? "PartialEq, " : "",
                "Serialize, Deserialize)]",
            );

            // List the possible naming styles for every enum case
            const enumCasesNamingStyles: { [key: string]: string[] } = {};
            this.forEachEnumCase(e, "none", (_name, value) => {
                const actualValue = String(value);
                enumCasesNamingStyles[actualValue] = listMatchingNamingStyles(actualValue);
            });

            // Set the default naming style on the enum
            const defaultStyle = "PascalCase";
            const preferedNamingStyle = getPreferredNamingStyle(
                Object.values(enumCasesNamingStyles).flat(),
                defaultStyle,
            );
            if (preferedNamingStyle !== defaultStyle) {
                this.emitLine(`#[serde(rename_all = "${preferedNamingStyle}")]`);
            }

            const blankLines = this._options.density === Density.Dense ? "none" : "interposing";
            this.emitBlock(["pub enum ", enumName], () =>
                this.forEachEnumCase(e, blankLines, (name, value) => {
                    this.emitRenameAttribute(name, value as string, defaultStyle, preferedNamingStyle);
                    this.emitLine([name, ","]);
                }),
            );
            return;
        }

        // For pure number/boolean enums, use custom serialization to handle correct JSON types
        this.emitLine(
            "#[derive(",
            this._options.deriveDebug ? "Debug, " : "",
            this._options.deriveClone ? "Clone, " : "",
            this._options.derivePartialEq ? "PartialEq, " : "",
            ")]",
        );
        
        const blankLines = this._options.density === Density.Dense ? "none" : "interposing";
        this.emitBlock(["pub enum ", enumName], () => {
            this.forEachEnumCase(e, blankLines, (name, _value) => {
                this.emitLine([name, ","]);
            });
        });
        
        // Emit custom Serialize implementation for number/boolean enums
        this.ensureBlankLine();
        this.emitLine("impl Serialize for ", enumName, " {");
        this.indent(() => {
            this.emitLine("fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>");
            this.emitLine("where");
            this.indent(() => {
                this.emitLine("S: serde::Serializer,");
            });
            this.emitLine("{");
            this.indent(() => {
                this.emitLine("match self {");
                this.indent(() => {
                    this.forEachEnumCase(e, "none", (name, value) => {
                        if (typeof value === "number") {
                            if (Number.isInteger(value)) {
                                this.emitLine(enumName, "::", name, " => serializer.serialize_i64(", String(value), "),");
                            } else {
                                this.emitLine(enumName, "::", name, " => serializer.serialize_f64(", String(value), "),");
                            }
                        } else if (typeof value === "boolean") {
                            this.emitLine(enumName, "::", name, " => serializer.serialize_bool(", String(value), "),");
                        }
                    });
                });
                this.emitLine("}");
            });
            this.emitLine("}");
        });
        this.emitLine("}");
        
        // Emit custom Deserialize implementation for number/boolean enums
        this.ensureBlankLine();
        this.emitLine("impl<'de> serde::Deserialize<'de> for ", enumName, " {");
        this.indent(() => {
            this.emitLine("fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>");
            this.emitLine("where");
            this.indent(() => {
                this.emitLine("D: serde::Deserializer<'de>,");
            });
            this.emitLine("{");
            this.indent(() => {
                this.emitLine("struct ", enumName, "Visitor;");
                this.ensureBlankLine();
                
                this.emitLine("impl<'de> serde::de::Visitor<'de> for ", enumName, "Visitor {");
                this.indent(() => {
                    this.emitLine("type Value = ", enumName, ";");
                    this.ensureBlankLine();
                    
                    this.emitLine("fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {");
                    this.indent(() => {
                        this.emitLine("formatter.write_str(\"a valid ", enumName, " value\")");
                    });
                    this.emitLine("}");
                    this.ensureBlankLine();
                    
                    if (e.valueType === "number") {
                        this.emitLine("fn visit_i64<E>(self, value: i64) -> Result<", enumName, ", E>");
                        this.emitLine("where");
                        this.indent(() => {
                            this.emitLine("E: serde::de::Error,");
                        });
                        this.emitLine("{");
                        this.indent(() => {
                            this.emitLine("match value {");
                            this.indent(() => {
                                this.forEachEnumCase(e, "none", (name, caseValue) => {
                                    if (typeof caseValue === "number" && Number.isInteger(caseValue)) {
                                        this.emitLine(String(caseValue), " => Ok(", enumName, "::", name, "),");
                                    }
                                });
                                this.emitLine("_ => Err(E::invalid_value(serde::de::Unexpected::Signed(value), &self)),");
                            });
                            this.emitLine("}");
                        });
                        this.emitLine("}");
                        this.ensureBlankLine();
                        
                        this.emitLine("fn visit_f64<E>(self, value: f64) -> Result<", enumName, ", E>");
                        this.emitLine("where");
                        this.indent(() => {
                            this.emitLine("E: serde::de::Error,");
                        });
                        this.emitLine("{");
                        this.indent(() => {
                            this.emitLine("match value {");
                            this.indent(() => {
                                this.forEachEnumCase(e, "none", (name, caseValue) => {
                                    if (typeof caseValue === "number") {
                                        this.emitLine("v if v == ", String(caseValue), " => Ok(", enumName, "::", name, "),");
                                    }
                                });
                                this.emitLine("_ => Err(E::invalid_value(serde::de::Unexpected::Float(value), &self)),");
                            });
                            this.emitLine("}");
                        });
                        this.emitLine("}");
                    } else if (e.valueType === "boolean") {
                        this.emitLine("fn visit_bool<E>(self, value: bool) -> Result<", enumName, ", E>");
                        this.emitLine("where");
                        this.indent(() => {
                            this.emitLine("E: serde::de::Error,");
                        });
                        this.emitLine("{");
                        this.indent(() => {
                            this.emitLine("match value {");
                            this.indent(() => {
                                this.forEachEnumCase(e, "none", (name, caseValue) => {
                                    if (typeof caseValue === "boolean") {
                                        this.emitLine(String(caseValue), " => Ok(", enumName, "::", name, "),");
                                    }
                                });
                                this.emitLine("_ => Err(E::invalid_value(serde::de::Unexpected::Bool(value), &self)),");
                            });
                            this.emitLine("}");
                        });
                        this.emitLine("}");
                    }
                });
                this.emitLine("}");
                this.ensureBlankLine();
                
                if (e.valueType === "number") {
                    this.emitLine("deserializer.deserialize_f64(", enumName, "Visitor)");
                } else if (e.valueType === "boolean") {
                    this.emitLine("deserializer.deserialize_bool(", enumName, "Visitor)");
                }
            });
            this.emitLine("}");
        });
        this.emitLine("}");
    }

    protected emitTopLevelAlias(t: Type, name: Name): void {
        this.emitLine("pub type ", name, " = ", this.rustType(t), ";");
    }

    protected emitLeadingComments(): void {
        if (this.leadingComments !== undefined) {
            this.emitComments(this.leadingComments);
            return;
        }

        const topLevelName = defined(
            mapFirst(this.topLevels),
        ).getCombinedName();
        this.emitMultiline(
            `// Example code that deserializes and serializes the model.
// extern crate serde;
// #[macro_use]
// extern crate serde_derive;
// extern crate serde_json;
//
// use generated_module::${topLevelName};
//
// fn main() {
//     let json = r#"{"answer": 42}"#;
//     let model: ${topLevelName} = serde_json::from_str(&json).unwrap();
// }`,
        );
    }

    protected emitSourceStructure(): void {
        if (this._options.leadingComments) {
            this.emitLeadingComments();
        }

        this.ensureBlankLine();
        if (this._options.edition2018) {
            this.emitLine("use serde::{Serialize, Deserialize};");
        } else {
            this.emitLine("extern crate serde_derive;");
        }

        if (this.haveMaps) {
            this.emitLine("use std::collections::HashMap;");
        }

        this.forEachTopLevel(
            "leading",
            (t, name) => this.emitTopLevelAlias(t, name),
            (t) => this.namedTypeToNameForTopLevel(t) === undefined,
        );

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, name: Name) => this.emitStructDefinition(c, name),
            (e, name) => this.emitEnumDefinition(e, name),
            (u, name) => this.emitUnion(u, name),
        );
    }
}

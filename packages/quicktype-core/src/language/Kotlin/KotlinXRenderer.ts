import type { Name } from "../../Naming";
import type { RenderContext } from "../../Renderer";
import type { OptionValues } from "../../RendererOptions";
import { type Sourcelike, modifySource } from "../../Source";
import { camelCase } from "../../support/Strings";
import type { TargetLanguage } from "../../TargetLanguage";
import type {
    ArrayType,
    EnumType,
    MapType,
    Type,
} from "../../Type";

import { KotlinRenderer } from "./KotlinRenderer";
import type { kotlinOptions } from "./language";
import { stringEscape } from "./utils";

/**
 * Currently supports simple classes, enums, and TS string unions (which are also enums).
 * TODO: Union, Any, Top Level Array, Top Level Map
 */
export class KotlinXRenderer extends KotlinRenderer {
    public constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        _kotlinOptions: OptionValues<typeof kotlinOptions>,
    ) {
        super(targetLanguage, renderContext, _kotlinOptions);
    }

    protected anySourceType(optional: string): Sourcelike {
        return ["JsonElement", optional];
    }

    protected arrayType(
        arrayType: ArrayType,
        withIssues = false,
        noOptional = false,
    ): Sourcelike {
        const valType = this.kotlinType(arrayType.items, withIssues, true);
        const name = this.sourcelikeToString(valType);
        if (name === "JsonObject" || name === "JsonElement") {
            return "JsonArray";
        }

        return super.arrayType(arrayType, withIssues, noOptional);
    }

    protected mapType(
        mapType: MapType,
        withIssues = false,
        noOptional = false,
    ): Sourcelike {
        const valType = this.kotlinType(mapType.values, withIssues, true);
        const name = this.sourcelikeToString(valType);
        if (name === "JsonObject" || name === "JsonElement") {
            return "JsonObject";
        }

        return super.mapType(mapType, withIssues, noOptional);
    }

    protected emitTopLevelMap(t: MapType, name: Name): void {
        const elementType = this.kotlinType(t.values);
        if (elementType === "JsonObject") {
            this.emitLine(["typealias ", name, " = JsonObject"]);
        } else {
            super.emitTopLevelMap(t, name);
        }
    }

    protected emitTopLevelArray(t: ArrayType, name: Name): void {
        const elementType = this.kotlinType(t.items);
        this.emitLine(["typealias ", name, " = JsonArray<", elementType, ">"]);
    }

    protected emitUsageHeader(): void {
        this.emitLine(
            "// To parse the JSON, install kotlin's serialization plugin and do:",
        );
        this.emitLine("//");
        const table: Sourcelike[][] = [];
        table.push([
            "// val ",
            "json",
            " = Json { allowStructuredMapKeys = true }",
        ]);
        this.forEachTopLevel("none", (_, name) => {
            table.push([
                "// val ",
                modifySource(camelCase, name),
                ` = json.parse(${this.sourcelikeToString(name)}.serializer(), jsonString)`,
            ]);
        });
        this.emitTable(table);
    }

    protected emitHeader(): void {
        super.emitHeader();

        this.emitLine("import kotlinx.serialization.*");
        this.emitLine("import kotlinx.serialization.json.*");
        this.emitLine("import kotlinx.serialization.descriptors.*");
        this.emitLine("import kotlinx.serialization.encoding.*");
    }

    protected emitClassAnnotations(_c: Type, _className: Name): void {
        this.emitLine("@Serializable");
    }

    protected renameAttribute(
        name: Name,
        jsonName: string,
        _required: boolean,
        meta: Array<() => void>,
    ): void {
        const rename = this._rename(name, jsonName);
        if (rename !== undefined) {
            meta.push(() => this.emitLine(rename));
        }
    }

    private _rename(propName: Name, jsonName: string): Sourcelike | undefined {
        const escapedName = stringEscape(jsonName);
        const namesDiffer = this.sourcelikeToString(propName) !== escapedName;
        if (namesDiffer) {
            return ['@SerialName("', escapedName, '")'];
        }

        return undefined;
    }

    protected emitEnumDefinition(e: EnumType, enumName: Name): void {
        this.emitDescription(this.descriptionForType(e));

        // For mixed enums, use regular enum with custom serializer
        if (e.isMixed) {
            this.emitLine(["@Serializable(with = ", enumName, "Serializer::class)"]);
            this.emitBlock(["enum class ", enumName], () => {
                let count = e.cases.size;
                this.forEachEnumCase(e, "none", (name, _value) => {
                    this.emitLine(name, --count === 0 ? "" : ",");
                });
            });
            
            // Emit custom serializer
            this.ensureBlankLine();
            this.emitLine(["object ", enumName, "Serializer : KSerializer<", enumName, ">"]);
            this.emitBlock("", () => {
                this.emitLine("override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(\"", enumName, "\", PrimitiveKind.STRING)");
                this.ensureBlankLine();
                
                this.emitBlock("override fun serialize(encoder: Encoder, value: " + this.sourcelikeToString(enumName) + ")", () => {
                    this.emitLine("val jsonEncoder = encoder as JsonEncoder");
                    this.emitLine("when (value) {");
                    this.indent(() => {
                        this.forEachEnumCase(e, "none", (name, caseValue) => {
                            if (typeof caseValue === "string") {
                                this.emitLine(enumName, ".", name, " -> jsonEncoder.encodeJsonElement(JsonPrimitive(\"", stringEscape(caseValue), "\"))");
                            } else if (typeof caseValue === "number") {
                                this.emitLine(enumName, ".", name, " -> jsonEncoder.encodeJsonElement(JsonPrimitive(", String(caseValue), "))");
                            } else if (typeof caseValue === "boolean") {
                                this.emitLine(enumName, ".", name, " -> jsonEncoder.encodeJsonElement(JsonPrimitive(", String(caseValue), "))");
                            }
                        });
                    });
                    this.emitLine("}");
                });
                
                this.ensureBlankLine();
                this.emitBlock("override fun deserialize(decoder: Decoder): " + this.sourcelikeToString(enumName), () => {
                    this.emitLine("val jsonDecoder = decoder as JsonDecoder");
                    this.emitLine("return when (val element = jsonDecoder.decodeJsonElement()) {");
                    this.indent(() => {
                        this.emitLine("is JsonPrimitive -> {");
                        this.indent(() => {
                            this.emitLine("when {");
                            this.indent(() => {
                                this.forEachEnumCase(e, "none", (name, caseValue) => {
                                    if (typeof caseValue === "string") {
                                        this.emitLine("element.contentOrNull == \"", stringEscape(caseValue), "\" -> ", enumName, ".", name);
                                    } else if (typeof caseValue === "number") {
                                        if (Number.isInteger(caseValue)) {
                                            this.emitLine("element.intOrNull == ", String(caseValue), " -> ", enumName, ".", name);
                                        } else {
                                            this.emitLine("element.doubleOrNull == ", String(caseValue), " -> ", enumName, ".", name);
                                        }
                                    } else if (typeof caseValue === "boolean") {
                                        this.emitLine("element.booleanOrNull == ", String(caseValue), " -> ", enumName, ".", name);
                                    }
                                });
                                this.emitLine("else -> throw SerializationException(\"Unknown value: $element\")");
                            });
                            this.emitLine("}");
                        });
                        this.emitLine("}");
                        this.emitLine("else -> throw SerializationException(\"Expected primitive value\")");
                    });
                    this.emitLine("}");
                });
            });
            return;
        }

        // Determine the enum value type
        const valueType = e.valueType === "number" ? "Int" : 
                         e.valueType === "boolean" ? "Boolean" : "String";
        
        this.emitLine(["@Serializable"]);
        this.emitBlock(["enum class ", enumName, "(val value: ", valueType, ")"], () => {
            let count = e.cases.size;
            this.forEachEnumCase(e, "none", (name, value) => {
                if (e.valueType === "string") {
                    const escapedValue = stringEscape(value as string);
                    this.emitLine(
                        `@SerialName("${escapedValue}") `,
                        name,
                        `("${escapedValue}")`,
                        --count === 0 ? ";" : ",",
                    );
                } else if (e.valueType === "number") {
                    this.emitLine(
                        `@SerialName("${value}") `,
                        name,
                        `(${value})`,
                        --count === 0 ? ";" : ",",
                    );
                } else if (e.valueType === "boolean") {
                    this.emitLine(
                        `@SerialName("${value}") `,
                        name,
                        `(${value})`,
                        --count === 0 ? ";" : ",",
                    );
                }
            });
        });
    }
}

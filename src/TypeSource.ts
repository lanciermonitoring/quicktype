import type { Readable } from "readable-stream";

import type { JSONSchemaSourceData, JSONSourceData } from "@lanciermonitoring/quicktype-core";
import type { GraphQLSourceData } from "@lanciermonitoring/quicktype-graphql-input";

export interface JSONTypeSource extends JSONSourceData<Readable> {
    kind: "json";
}

export interface SchemaTypeSource extends JSONSchemaSourceData {
    kind: "schema";
}

export interface GraphQLTypeSource extends GraphQLSourceData {
    kind: "graphql";
}

export type TypeSource = GraphQLTypeSource | JSONTypeSource | SchemaTypeSource;

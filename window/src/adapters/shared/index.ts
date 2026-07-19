import type { ConnectorErrorCode, ConnectorSource } from "../../application/connectors";

export const MAX_PROVIDER_BYTES=1_048_576,MAX_PROVIDER_PAGES=20,MAX_PROVIDER_RECORDS_PER_PAGE=100,MAX_PROVIDER_RECORDS=2_000,MAX_CURSOR_LENGTH=100,MAX_PROVIDER_TEXT=512;
export const boundedProviderText=(value:unknown,max=MAX_PROVIDER_TEXT):value is string=>typeof value==="string"&&value.length>0&&Buffer.byteLength(value)<=max;
export const boundedCursor=(value:unknown):value is string|null=>value===null||typeof value==="string"&&value.length>0&&value.length<=MAX_CURSOR_LENGTH&&Buffer.byteLength(value)<=MAX_CURSOR_LENGTH;
export class AdapterBoundaryError extends Error{
  constructor(readonly source:ConnectorSource,readonly code:ConnectorErrorCode){super(code);this.name="AdapterBoundaryError";}
}
export const adapterFailure=(source:ConnectorSource,code:ConnectorErrorCode):never=>{throw new AdapterBoundaryError(source,code);};
export const exactObject=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join()===[...keys].sort().join();

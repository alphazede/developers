import type { ConnectorPrivacyService } from "../../../../../../application/connectors";
import { hasExactKeys, readBoundedJsonObject, RequestBoundaryError } from "../../../request-boundary";
import { getLiveConnectorRuntime } from "../../../../../../server/connectors/live-runtime";

/** Composition seam for the assembled SessionGuard plus Origin and CSRF checks. */
export type GoogleRouteAuthorization=(request:Request)=>boolean;
export const createGoogleRevokeHandler=(service:ConnectorPrivacyService,authorize:GoogleRouteAuthorization)=>async(request:Request)=>{
  try{if(!authorize(request))return Response.json({error:{code:"UNAUTHORIZED"}},{status:401,headers:{"cache-control":"private, no-store"}});const body=await readBoundedJsonObject(request,4_096);if(!hasExactKeys(body,["source","consentRevision"]))throw new Error("invalid");const value=body as {source:"google-calendar"|"gmail";consentRevision:number};if(!["google-calendar","gmail"].includes(value.source))throw new Error("invalid");return Response.json(await service.revoke(value.source,value.consentRevision),{headers:{"cache-control":"private, no-store"}});}catch(error){const status=error instanceof RequestBoundaryError?error.status:400;return Response.json({error:{code:status===413?"PAYLOAD_TOO_LARGE":"GOOGLE_REVOCATION_REJECTED"}},{status,headers:{"cache-control":"private, no-store"}});}
};
const disabled=()=>Response.json({error:{code:"GOOGLE_SOURCE_DISABLED",message:"Google connection is not configured.",retriable:false}},{status:503,headers:{"cache-control":"private, no-store"}});
export const POST=async(request:Request)=>{const runtime=await getLiveConnectorRuntime();if(!runtime)return disabled();const command=await runtime.authorizeMutation(request);if(!command)return Response.json({error:{code:"UNAUTHORIZED"}},{status:401,headers:{"cache-control":"private, no-store"}});const service={revoke:(source:Parameters<ConnectorPrivacyService["revoke"]>[0],revision:number)=>runtime.privacy.revoke(source,revision,command)} as ConnectorPrivacyService;return createGoogleRevokeHandler(service,()=>true)(request);};

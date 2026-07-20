import type { OneTimeOAuthService } from "../../../../../../server/oauth/one-time";
import { hasExactKeys, readBoundedJsonObject, RequestBoundaryError } from "../../../request-boundary";
import { getLiveConnectorRuntime } from "../../../../../../server/connectors/live-runtime";

export const createLinearOAuthStartHandler=(service:OneTimeOAuthService,sessionId:(request:Request)=>string|null)=>async(request:Request)=>{
  try{const session=sessionId(request),body=await readBoundedJsonObject(request,4_096);if(!session||!hasExactKeys(body,["consentRevision","redirectUri","returnPath"]))throw new Error("invalid");return Response.json(service.begin({...body as {consentRevision:number;redirectUri:string;returnPath:string},sessionId:session,access:"read"}),{headers:{"cache-control":"private, no-store"}});}catch(error){const status=error instanceof RequestBoundaryError?error.status:400;return Response.json({error:{code:status===413?"PAYLOAD_TOO_LARGE":"LINEAR_OAUTH_START_REJECTED"}},{status,headers:{"cache-control":"private, no-store"}});}
};
const disabled=()=>Response.json({error:{code:"LINEAR_OAUTH_DISABLED",message:"Linear connection is not configured.",retriable:false}},{status:503,headers:{"cache-control":"private, no-store"}});
export const POST=async(request:Request)=>{const runtime=await getLiveConnectorRuntime();if(!runtime?.linearOAuth)return disabled();const command=await runtime.authorizeMutation(request);if(!command)return Response.json({error:{code:"UNAUTHORIZED"}},{status:401,headers:{"cache-control":"private, no-store"}});const service={begin:(input:Parameters<OneTimeOAuthService["begin"]>[0])=>runtime.linearOAuth!.begin({...input,...command})} as OneTimeOAuthService;return createLinearOAuthStartHandler(service,(input)=>runtime.sessionId(input))(request);};

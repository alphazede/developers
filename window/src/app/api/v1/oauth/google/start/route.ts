import type { GoogleOAuthService } from "../../../../../../server/oauth";
import { hasExactKeys, readBoundedJsonObject, RequestBoundaryError } from "../../../request-boundary";
import { getLiveConnectorRuntime } from "../../../../../../server/connectors/live-runtime";

const disabled=()=>Response.json({error:{code:"GOOGLE_OAUTH_DISABLED",message:"Google Calendar connection is not configured.",retriable:false}},{status:503,headers:{"cache-control":"private, no-store"}});
export const createGoogleOAuthStartHandler=(service:GoogleOAuthService,sessionId:(request:Request)=>string|null)=>async(request:Request)=>{
  try{
    const session=sessionId(request),body=await readBoundedJsonObject(request,4_096);if(!session||!hasExactKeys(body,["calendarWrite","consentRevision","redirectUri","returnPath"]))throw new Error("invalid");
    return Response.json(service.begin({...body as {calendarWrite:boolean;consentRevision:number;redirectUri:string;returnPath:string},sessionId:session}),{headers:{"cache-control":"private, no-store"}});
  }catch(error){const status=error instanceof RequestBoundaryError?error.status:400;return Response.json({error:{code:status===413?"PAYLOAD_TOO_LARGE":"GOOGLE_OAUTH_START_REJECTED"}},{status,headers:{"cache-control":"private, no-store"}});}
};
export const POST=async(request:Request)=>{const runtime=await getLiveConnectorRuntime();if(!runtime?.googleOAuth)return disabled();const command=await runtime.authorizeMutation(request);if(!command)return Response.json({error:{code:"UNAUTHORIZED"}},{status:401,headers:{"cache-control":"private, no-store"}});const service={begin:(input:Parameters<GoogleOAuthService["begin"]>[0])=>runtime.googleOAuth!.begin({...input,...command})} as GoogleOAuthService;return createGoogleOAuthStartHandler(service,(input)=>runtime.sessionId(input))(request);};

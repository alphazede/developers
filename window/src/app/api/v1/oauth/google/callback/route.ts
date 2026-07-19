import type { GoogleOAuthService } from "../../../../../../server/oauth";
import { getLiveConnectorRuntime } from "../../../../../../server/connectors/live-runtime";

export const createGoogleOAuthCallbackHandler=(service:GoogleOAuthService,sessionId:(request:Request)=>string|null,redirectUri:string)=>async(request:Request)=>{
  try{const session=sessionId(request),url=new URL(request.url),states=url.searchParams.getAll("state"),codes=url.searchParams.getAll("code");if(!session||states.length!==1||codes.length!==1||[...url.searchParams.keys()].length!==2)throw new Error("invalid");return Response.json(await service.consume({state:states[0]!,code:codes[0]!,sessionId:session,redirectUri}),{headers:{"cache-control":"private, no-store"}});}catch{return Response.json({error:{code:"GOOGLE_OAUTH_CALLBACK_REJECTED"}},{status:400,headers:{"cache-control":"private, no-store"}});}
};
export const GET=async(request:Request)=>{const runtime=await getLiveConnectorRuntime();return runtime?.googleOAuth?createGoogleOAuthCallbackHandler(runtime.googleOAuth,(input)=>runtime.sessionId(input,true),runtime.config.google!.redirectUri)(request):Response.json({error:{code:"GOOGLE_OAUTH_DISABLED",message:"Google Calendar connection is not configured.",retriable:false}},{status:503,headers:{"cache-control":"private, no-store"}});};

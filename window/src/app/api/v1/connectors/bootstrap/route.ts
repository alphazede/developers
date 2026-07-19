import { getLiveConnectorRuntime } from "../../../../../server/connectors/live-runtime";
import { hasExactKeys, readBoundedJsonObject, RequestBoundaryError } from "../../request-boundary";

const reply=(code:string,status:number)=>Response.json({error:{code}},{status,headers:{"cache-control":"private, no-store"}});
export const POST=async(request:Request)=>{
  const runtime=await getLiveConnectorRuntime();if(!runtime)return reply("CONNECTOR_BOOTSTRAP_DISABLED",503);
  if(!runtime.authorizeBootstrap(request))return reply("UNAUTHORIZED",401);
  try{const body=await readBoundedJsonObject(request,1_024);if(!hasExactKeys(body,["profileId","timeZone"]))return reply("BOOTSTRAP_REJECTED",400);return Response.json(await runtime.bootstrap(body as {profileId:string;timeZone:string}),{status:201,headers:{"cache-control":"private, no-store"}});}
  catch(error){if(error instanceof RequestBoundaryError)return reply(error.status===413?"PAYLOAD_TOO_LARGE":"BOOTSTRAP_REJECTED",error.status);return reply("BOOTSTRAP_REFUSED",409);}
};

import type { GitHubInstallationService } from "../../../../../../server/oauth/github-installation";
import { hasExactKeys, readBoundedJsonObject, RequestBoundaryError } from "../../../request-boundary";
import { getLiveConnectorRuntime } from "../../../../../../server/connectors/live-runtime";

export const createGitHubOAuthStartHandler=(service:GitHubInstallationService,sessionId:(request:Request)=>string|null)=>async(request:Request)=>{
  try{const session=sessionId(request),body=await readBoundedJsonObject(request,4_096);if(!session||!hasExactKeys(body,["consentRevision"]))throw new Error("invalid");return Response.json(service.begin({sessionId:session,consentRevision:body.consentRevision as number}),{headers:{"cache-control":"private, no-store"}});}catch(error){const status=error instanceof RequestBoundaryError?error.status:400;return Response.json({error:{code:status===413?"PAYLOAD_TOO_LARGE":"GITHUB_OAUTH_START_REJECTED"}},{status,headers:{"cache-control":"private, no-store"}});}
};
const disabled=()=>Response.json({error:{code:"GITHUB_OAUTH_DISABLED",message:"GitHub App connection is not configured.",retriable:false}},{status:503,headers:{"cache-control":"private, no-store"}});
export const POST=async(request:Request)=>{const runtime=await getLiveConnectorRuntime();if(!runtime?.githubOAuth)return disabled();const command=await runtime.authorizeMutation(request);if(!command)return Response.json({error:{code:"UNAUTHORIZED"}},{status:401,headers:{"cache-control":"private, no-store"}});const service={begin:(input:Parameters<GitHubInstallationService["begin"]>[0])=>runtime.githubOAuth!.begin({...input,...command})} as GitHubInstallationService;return createGitHubOAuthStartHandler(service,(input)=>runtime.sessionId(input))(request);};

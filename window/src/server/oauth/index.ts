import type { TokenRepository } from "../../application/connectors";
import type { DataKeyManager } from "../security/crypto";
import { OAuthBoundaryError, OneTimeOAuthService, oneTimeOAuthConfiguration, type OneTimeOAuthConfiguration, type OneTimeOAuthExchangePort } from "./one-time";

export { GitHubInstallationService, type GitHubInstallationExchangePort } from "./github-installation";
export { GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_WRITE_SCOPE, LINEAR_READ_SCOPE, OAuthBoundaryError, OneTimeOAuthService, oneTimeOAuthConfiguration, type OneTimeOAuthAccess, type OneTimeOAuthConfiguration, type OneTimeOAuthExchangePort, type OneTimeOAuthProvider } from "./one-time";
export const GMAIL_ADDON_SELECTED_SCOPE="https://www.googleapis.com/auth/gmail.addons.current.message.readonly";
export type GoogleOAuthConfiguration=Readonly<{clientId:string;clientSecret:string;redirectUri:string}>;
export type OAuthExchangePort=OneTimeOAuthExchangePort;

export const googleOAuthConfiguration=(environment:Record<string,string|undefined>):GoogleOAuthConfiguration|null=>{const config=oneTimeOAuthConfiguration("google-calendar",environment);return config?Object.freeze({clientId:config.clientId,clientSecret:config.clientSecret,redirectUri:config.redirectUri}):null;};

export class GoogleOAuthService{
  private readonly service:OneTimeOAuthService;
  constructor(config:GoogleOAuthConfiguration,exchange:OAuthExchangePort,keys:Pick<DataKeyManager,"load">,tokens:TokenRepository,clock:Readonly<{now():number}>,entropy?:(bytes:number)=>Uint8Array,withTimeout?:<T>(operation:Promise<T>,milliseconds:number,onTimeout:()=>void)=>Promise<T>){
    const generic:OneTimeOAuthConfiguration={provider:"google-calendar",clientId:config.clientId,clientSecret:config.clientSecret,redirectUri:config.redirectUri,authorizationEndpoint:"https://accounts.google.com/o/oauth2/v2/auth",tokenEndpoint:"https://oauth2.googleapis.com/token"};
    this.service=new OneTimeOAuthService(generic,exchange,keys,tokens,clock,entropy,withTimeout);
  }
  begin(input:Readonly<{sessionId:string;redirectUri:string;returnPath:string;consentRevision:number;calendarWrite:boolean;expectedRevision?:number;commandId?:string;idempotencyKey?:string}>){if(!input||typeof input.calendarWrite!=="boolean"||!["calendarWrite,consentRevision,redirectUri,returnPath,sessionId","calendarWrite,commandId,consentRevision,expectedRevision,idempotencyKey,redirectUri,returnPath,sessionId"].includes(Object.keys(input).sort().join()))throw new OAuthBoundaryError("OAUTH_INVALID");const {calendarWrite,...shared}=input;return this.service.begin({...shared,access:calendarWrite?"read-write":"read"});}
  consume(input:Readonly<{state:string;code:string;sessionId:string;redirectUri:string}>){return this.service.consume(input);}
}

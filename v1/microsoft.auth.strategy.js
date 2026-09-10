"use strict";
Object.defineProperty(exports, "__esModule", {
    value: true
});
Object.defineProperty(exports, "MicrosoftStrategy", {
    enumerable: true,
    get: function() {
        return MicrosoftStrategy;
    }
});
const _common = require("@nestjs/common");
const _passport = require("@nestjs/passport");
const _passportmicrosoft = require("passport-microsoft");
const _utils = require("twenty-shared/utils");
const _authexception = require("../auth.exception");
function _ts_decorate(decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for(var i = decorators.length - 1; i >= 0; i--)if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
}
function _ts_metadata(k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
}
let MicrosoftStrategy = class MicrosoftStrategy extends (0, _passport.PassportStrategy)(_passportmicrosoft.Strategy, 'microsoft') {
    authenticate(req, options) {
        options = {
            ...options,
            state: JSON.stringify({
                workspaceInviteHash: req.query.workspaceInviteHash,
                workspaceId: req.params.workspaceId,
                locale: req.query.locale,
                billingCheckoutSessionState: req.query.billingCheckoutSessionState,
                workspacePersonalInviteToken: req.query.workspacePersonalInviteToken,
                action: req.query.action,
                oauthRetryCount: req.query.oauthRetryCount ? Number(req.query.oauthRetryCount) : undefined
            })
        };
        return super.authenticate(req, options);
    }
    async validate(request, _accessToken, _refreshToken, profile, done) {
        const { name, userPrincipalName, photos } = profile;
        const state = (0, _utils.parseJson)(request.query.state);
        if (!userPrincipalName) {
            throw new _authexception.AuthException('User principal name not found', _authexception.AuthExceptionCode.INVALID_INPUT);
        }
        const user = {
            email: userPrincipalName,
            firstName: name?.givenName,
            lastName: name?.familyName,
            picture: photos?.[0]?.value ?? null,
            workspaceInviteHash: state?.workspaceInviteHash,
            workspacePersonalInviteToken: state?.workspacePersonalInviteToken,
            workspaceId: state?.workspaceId,
            billingCheckoutSessionState: state?.billingCheckoutSessionState,
            locale: state?.locale,
            action: state?.action ?? 'list-available-workspaces'
        };
        done(null, user);
    }
    constructor(twentyConfigService){
        super({
            clientID: twentyConfigService.get('AUTH_MICROSOFT_CLIENT_ID'),
            clientSecret: twentyConfigService.get('AUTH_MICROSOFT_CLIENT_SECRET'),
            callbackURL: twentyConfigService.get('AUTH_MICROSOFT_CALLBACK_URL'),
            tenant: twentyConfigService.get('AUTH_MICROSOFT_TENANT_ID') || process.env.AUTH_MICROSOFT_TENANT_ID,
            scope: [
                'user.read'
            ],
            passReqToCallback: true
        });
    }
};
MicrosoftStrategy = _ts_decorate([
    (0, _common.Injectable)(),
    _ts_metadata("design:type", Function),
    _ts_metadata("design:paramtypes", [
        typeof TwentyConfigService === "undefined" ? Object : TwentyConfigService
    ])
], MicrosoftStrategy);

//# sourceMappingURL=microsoft.auth.strategy.js.map

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
const _passport = require("@nestjs/passport");
const _passportmicrosoft = require("passport-microsoft");
const _authexception = require("../auth.exception");
let MicrosoftStrategy = class MicrosoftStrategy extends (0, _passport.PassportStrategy)(_passportmicrosoft.Strategy, 'microsoft') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authenticate(req, options) {
        options = {
            ...options,
            state: JSON.stringify({
                workspaceInviteHash: req.query.workspaceInviteHash,
                workspaceId: req.params.workspaceId,
                locale: req.query.locale,
                billingCheckoutSessionState: req.query.billingCheckoutSessionState,
                workspacePersonalInviteToken: req.query.workspacePersonalInviteToken,
                action: req.query.action
            })
        };
        return super.authenticate(req, options);
    }
    async validate(request, _accessToken, _refreshToken, // eslint-disable-next-line @typescript-eslint/no-explicit-any
    profile, done) {
        const { name, userPrincipalName, photos } = profile;
        const state = typeof request.query.state === 'string' ? JSON.parse(request.query.state) : undefined;
        if (!userPrincipalName) {
            throw new _authexception.AuthException('User principal name not found', _authexception.AuthExceptionCode.INVALID_INPUT);
        }
        const user = {
            email: userPrincipalName,
            firstName: name.givenName,
            lastName: name.familyName,
            picture: photos?.[0]?.value,
            workspaceInviteHash: state.workspaceInviteHash,
            workspacePersonalInviteToken: state.workspacePersonalInviteToken,
            workspaceId: state.workspaceId,
            billingCheckoutSessionState: state.billingCheckoutSessionState,
            locale: state.locale,
            action: state.action
        };
        done(null, user);
    }
    constructor(twentyConfigService){
        super({
            clientID: twentyConfigService.get('AUTH_MICROSOFT_CLIENT_ID'),
            clientSecret: twentyConfigService.get('AUTH_MICROSOFT_CLIENT_SECRET'),
            callbackURL: twentyConfigService.get('AUTH_MICROSOFT_CALLBACK_URL'),
            tenant: twentyConfigService.get('AUTH_MICROSOFT_TENANT_ID'),
            scope: [
                'user.read'
            ],
            passReqToCallback: true
        });
    }
};

//# sourceMappingURL=microsoft.auth.strategy.js.map
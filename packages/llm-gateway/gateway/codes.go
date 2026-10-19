package gateway

// Problem codes: the closed set of reasons the gateway reports. The UI
// translates a code (with its params) into the user's language; Message is an
// English diagnostic for logs and never drives what the UI says. Add a code
// here, to codes.json and to LLM_CODES in packages/client-contracts/src/llm.ts
// together (codes_test.go and the client-contracts test keep the three equal).
//
//	code                    params              meaning
//	login_expired                               the provider no longer accepts the login; sign in again
//	invalid_api_key                             the provider rejects the API key
//	quota_exhausted                             the account's quota is used up; retry_at says when it recovers
//	rate_limited                                too many requests; retry_at says when it recovers
//	upstream_error          status              the provider refused the account (HTTP 402/403)
//	upstream_unstable       status              a transient provider failure; the account recovers by itself
//	upstream_unreachable                        the provider could not be reached
//	account_disabled                            the user disabled the account
//	model_disabled                              the model is disabled
//	model_quota_exhausted   provider            the account's quota for the model is used up
//	model_forbidden         provider, status    the account may not use the model
//	model_not_found         provider            the provider does not offer the model
//	no_connection           provider            no account is linked for the provider
//	check_failed                                the account could not be checked; its status is unchanged
//	usage_unavailable                           the subscription windows could not be read
//	no_token                                    the account has no usable token
//	login_start_failed      provider            the login could not be started
//	login_timeout                               the API key entry timed out
//	device_code_timeout                         the device code expired before it was approved
//	login_failed                                the provider ended the login with an error
//	login_save_failed                           the login succeeded but the credential could not be kept
//	api_key_required                            an empty API key was submitted
//	duplicate_api_key                           the API key was added before
//	key_check_unavailable   provider            the provider could not be reached to check the key
//	not_found                                   unknown connector, connection or login
//	invalid_request                             the request body is malformed
//	unsupported                                 the connector does not support the operation
//	gateway_unavailable                         any other failure inside the gateway
const (
	CodeLoginExpired        = "login_expired"
	CodeInvalidAPIKey       = "invalid_api_key"
	CodeQuotaExhausted      = "quota_exhausted"
	CodeRateLimited         = "rate_limited"
	CodeUpstreamError       = "upstream_error"
	CodeUpstreamUnstable    = "upstream_unstable"
	CodeUpstreamUnreachable = "upstream_unreachable"
	CodeAccountDisabled     = "account_disabled"
	CodeModelDisabled       = "model_disabled"
	CodeModelQuotaExhausted = "model_quota_exhausted"
	CodeModelForbidden      = "model_forbidden"
	CodeModelNotFound       = "model_not_found"
	CodeNoConnection        = "no_connection"
	CodeCheckFailed         = "check_failed"
	CodeUsageUnavailable    = "usage_unavailable"
	CodeNoToken             = "no_token"
	CodeLoginStartFailed    = "login_start_failed"
	CodeLoginTimeout        = "login_timeout"
	CodeDeviceCodeTimeout   = "device_code_timeout"
	CodeLoginFailed         = "login_failed"
	CodeLoginSaveFailed     = "login_save_failed"
	CodeAPIKeyRequired      = "api_key_required"
	CodeDuplicateAPIKey     = "duplicate_api_key"
	CodeKeyCheckUnavailable = "key_check_unavailable"
	CodeNotFound            = "not_found"
	CodeInvalidRequest      = "invalid_request"
	CodeUnsupported         = "unsupported"
	CodeGatewayUnavailable  = "gateway_unavailable"
)

// Codes lists every code, in the order of the table above. codes.json is the
// same list for the TypeScript side.
var Codes = []string{
	CodeLoginExpired, CodeInvalidAPIKey, CodeQuotaExhausted, CodeRateLimited,
	CodeUpstreamError, CodeUpstreamUnstable, CodeUpstreamUnreachable,
	CodeAccountDisabled, CodeModelDisabled, CodeModelQuotaExhausted,
	CodeModelForbidden, CodeModelNotFound, CodeNoConnection, CodeCheckFailed,
	CodeUsageUnavailable, CodeNoToken, CodeLoginStartFailed, CodeLoginTimeout,
	CodeDeviceCodeTimeout, CodeLoginFailed, CodeLoginSaveFailed,
	CodeAPIKeyRequired, CodeDuplicateAPIKey, CodeKeyCheckUnavailable,
	CodeNotFound, CodeInvalidRequest, CodeUnsupported, CodeGatewayUnavailable,
}

// Params are a problem's structured values: "provider" (a display name) and
// "status" (an HTTP status code).
type Params map[string]any

// Problem is a product-level explanation of a failure: a stable code, its
// params, and an English diagnostic message that is only for logs.
type Problem struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Params  Params `json:"params,omitempty"`
}

// problem builds a Problem; params are alternating names and values.
func problem(code, message string, params ...any) *Problem {
	p := &Problem{Code: code, Message: message}
	for i := 0; i+1 < len(params); i += 2 {
		if p.Params == nil {
			p.Params = Params{}
		}
		p.Params[params[i].(string)] = params[i+1]
	}
	return p
}

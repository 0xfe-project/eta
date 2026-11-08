// The kit's interface texts. `llmProblemMessages` is the gateway's codes in the words of
// apps/web/src/locales/en/llm.json and apps/web/src/locales/zh/llm.json (`problems`), with
// `{{name}}` written as `{name}`.

import { defineMessages } from "../../i18n/messages";

export const kitMessages = defineMessages({
  en: {
    moreAbove: "↑ {count} more",
    moreBelow: "↓ {count} more",
    disconnected: "Not connected to the host",
    timeout: "The host did not answer",
    agentsLoading: "Loading agents…",
    agentsEmpty: "No agents yet",
    pickerFooter: "↑↓ to move · Enter to choose · Esc to close",
    providersMissing: "This host has no providers plugin",
  },
  zh: {
    moreAbove: "↑ 还有 {count} 项",
    moreBelow: "↓ 还有 {count} 项",
    disconnected: "没有连上 host",
    timeout: "host 没有回应",
    agentsLoading: "正在读取智能体…",
    agentsEmpty: "还没有智能体",
    pickerFooter: "↑↓ 移动 · Enter 选择 · Esc 关闭",
    providersMissing: "这台 host 没开 providers 插件",
  },
});

export const llmProblemMessages = defineMessages({
  en: {
    login_expired: "The login has expired. Sign in again.",
    invalid_api_key: "The API key is invalid. Enter it again.",
    quota_exhausted:
      "The quota is used up. The account resumes automatically once it recovers.",
    rate_limited: "Too many requests. The account recovers shortly.",
    upstream_error:
      "The provider refused this account (HTTP {status}). It may lack access or have been suspended.",
    upstream_unstable:
      "The provider is failing temporarily (HTTP {status}). Retrying automatically.",
    upstream_unreachable:
      "The provider can't be reached right now. Retrying automatically.",
    account_disabled: "The account is disabled.",
    model_disabled: "This model is disabled.",
    model_quota_exhausted:
      "The {provider} account's quota for this model is used up. It can be used again once it recovers.",
    model_forbidden:
      "The {provider} account isn't allowed to use this model (HTTP {status}).",
    model_not_found: "{provider} doesn't offer this model.",
    no_connection: "No {provider} account is linked yet.",
    check_failed:
      "Couldn't reach the provider to check the account. The status is unchanged.",
    usage_unavailable: "Couldn't read usage right now.",
    no_token: "This account has no usable login token.",
    login_start_failed: "Couldn't start the {provider} login. Try again later.",
    login_timeout: "Timed out. Enter the key again.",
    device_code_timeout: "The code expired. Start again.",
    login_failed: "Login failed. Try again.",
    login_save_failed:
      "Logged in, but the credentials couldn't be saved. Try again.",
    api_key_required: "Enter an API key.",
    duplicate_api_key: "This API key has already been added.",
    key_check_unavailable:
      "Couldn't reach {provider} to check the API key. Try again later.",
    not_found: "Not found.",
    invalid_request: "The request is invalid.",
    unsupported: "This connector doesn't support that action.",
    gateway_unavailable:
      "The model service is unavailable right now. Try again later.",
  },
  zh: {
    login_expired: "登录已失效，请重新登录。",
    invalid_api_key: "API key 无效，请重新填写。",
    quota_exhausted: "额度已用尽，恢复后会自动继续使用。",
    rate_limited: "请求过于频繁，稍后会自动恢复。",
    upstream_error:
      "上游拒绝了该账号（HTTP {status}），可能没有使用权限或已被停用。",
    upstream_unstable: "上游暂时故障（HTTP {status}），稍后会自动重试。",
    upstream_unreachable: "上游暂时无法连接，稍后会自动重试。",
    account_disabled: "账号已停用。",
    model_disabled: "该模型已停用。",
    model_quota_exhausted:
      "{provider} 账号的该模型额度已用尽，恢复后可继续使用。",
    model_forbidden: "{provider} 账号无权使用该模型（HTTP {status}）。",
    model_not_found: "{provider} 暂不提供该模型。",
    no_connection: "尚未绑定 {provider} 账号。",
    check_failed: "暂时无法连接上游，未能完成检查；状态保持不变。",
    usage_unavailable: "暂时无法读取用量。",
    no_token: "该账号没有可用的登录令牌。",
    login_start_failed: "无法发起 {provider} 登录，请稍后再试。",
    login_timeout: "已超时，请重新填写。",
    device_code_timeout: "验证码已过期，请重新发起。",
    login_failed: "登录失败，请重试。",
    login_save_failed: "登录成功但保存凭据失败，请重试。",
    api_key_required: "请填写 API key。",
    duplicate_api_key: "这个 API key 已经添加过了。",
    key_check_unavailable: "暂时无法连接 {provider} 校验 API key，请稍后再试。",
    not_found: "资源不存在。",
    invalid_request: "请求参数无效。",
    unsupported: "该连接方式不支持此操作。",
    gateway_unavailable: "模型服务暂时不可用，请稍后再试。",
  },
});

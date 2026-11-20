import type { PlaceFailure } from "@eta/client-contracts";
import { PLACE_PROBLEMS } from "@eta/client-contracts";
import { WireError } from "@eta/client-contracts/wire";
import { localizedText } from "../../i18n";

export function placeFailure(error: unknown): PlaceFailure {
  const problem = error instanceof WireError ? error.problem : undefined;
  const code = PLACE_PROBLEMS.find((code) => code === problem?.code) ?? "other";
  const detail = problem?.params?.detail;
  if (typeof detail === "string" && detail) return { code, detail };
  return code === "other" ? { code, detail: String(error) } : { code };
}

export function failureText(failure: PlaceFailure) {
  switch (failure.code) {
    case "offline":
      return localizedText("This machine is offline.", "这台机器已离线。");
    case "timeout":
      return localizedText(
        "The machine did not answer in time.",
        "机器响应超时。",
      );
    case "unsupported":
      return localizedText(
        "This action is unavailable on this machine.",
        "这台机器不支持此操作。",
      );
    case "not_found":
      return localizedText("That directory does not exist.", "该目录不存在。");
    case "denied":
      return localizedText(
        "The machine denied access to this directory.",
        "机器拒绝访问该目录。",
      );
    case "not_directory":
      return localizedText("That path is not a directory.", "该路径不是目录。");
    case "exists":
      return localizedText(
        "A directory with that name already exists.",
        "同名目录已存在。",
      );
    case "invalid":
      return localizedText(
        "Enter a valid path, directory name, or repository URL.",
        "请输入有效的路径、目录名称或仓库 URL。",
      );
    case "not_absolute":
      return localizedText(
        "Enter an absolute path or start with ~.",
        "请输入绝对路径或以 ~ 开头的路径。",
      );
    case "auth":
      return localizedText(
        "Git could not authenticate to this repository.",
        "Git 无法验证该仓库的访问权限。",
      );
    case "network":
      return localizedText(
        "Git could not reach the repository.",
        "Git 无法连接该仓库。",
      );
    case "repo_not_found":
      return localizedText(
        "Git could not find the repository.",
        "Git 找不到该仓库。",
      );
    case "cancelled":
      return localizedText("Clone cancelled.", "已取消克隆。");
    case "no_git":
      return localizedText(
        "Git is unavailable on this machine.",
        "这台机器未安装 Git。",
      );
    case "gh_signed_out":
      return localizedText(
        "GitHub CLI is signed out. Paste a repository URL.",
        "GitHub CLI 尚未登录。请粘贴仓库 URL。",
      );
    default:
      return (
        failure.detail ||
        localizedText(
          "The machine could not complete this action.",
          "机器无法完成该操作。",
        )
      );
  }
}

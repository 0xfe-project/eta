/**
 * What the Windows service layer needs from Windows, through `bun:ffi`: nothing else can answer the
 * Service Control Manager, and `sc.exe` takes a password on its command line and answers in the
 * language of the system.
 *
 * Only what `service-windows.ts` and `windows-shell.ts` use is here, shaped the way they use it.
 * Each library is opened on first use, so this module loads anywhere. Every layout below is the
 * 64-bit one: there is no other Windows build.
 */
import type { FFIFunction, Library, Pointer } from "bun:ffi";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  ptr as addressOf,
  cc,
  dlopen,
  FFIType,
  read,
  toArrayBuffer,
} from "bun:ffi";

const { i32, ptr, u32 } = FFIType;

const load = <T>(open: () => T): (() => T) => {
  let opened: T | undefined;
  return () => (opened ??= open());
};

const advapi32 = load(() =>
  dlopen("advapi32.dll", {
    ChangeServiceConfig2W: { args: [ptr, u32, ptr], returns: i32 },
    ChangeServiceConfigW: {
      args: [ptr, u32, u32, u32, ptr, ptr, ptr, ptr, ptr, ptr, ptr],
      returns: i32,
    },
    CloseServiceHandle: { args: [ptr], returns: i32 },
    ControlService: { args: [ptr, u32, ptr], returns: i32 },
    ConvertSidToStringSidW: { args: [ptr, ptr], returns: i32 },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: [ptr, u32, ptr, ptr],
      returns: i32,
    },
    ConvertStringSidToSidW: { args: [ptr, ptr], returns: i32 },
    CreateServiceW: {
      args: [ptr, ptr, ptr, u32, u32, u32, u32, ptr, ptr, ptr, ptr, ptr, ptr],
      returns: ptr,
    },
    DeleteService: { args: [ptr], returns: i32 },
    GetTokenInformation: { args: [ptr, u32, ptr, u32, ptr], returns: i32 },
    LogonUserW: { args: [ptr, ptr, ptr, u32, u32, ptr], returns: i32 },
    LsaAddAccountRights: { args: [ptr, ptr, ptr, u32], returns: u32 },
    LsaClose: { args: [ptr], returns: u32 },
    LsaEnumerateAccountRights: { args: [ptr, ptr, ptr, ptr], returns: u32 },
    LsaFreeMemory: { args: [ptr], returns: u32 },
    LsaNtStatusToWinError: { args: [u32], returns: u32 },
    LsaOpenPolicy: { args: [ptr, ptr, u32, ptr], returns: u32 },
    LsaRemoveAccountRights: { args: [ptr, ptr, i32, ptr, u32], returns: u32 },
    OpenProcessToken: { args: [ptr, u32, ptr], returns: i32 },
    OpenSCManagerW: { args: [ptr, ptr, u32], returns: ptr },
    OpenServiceW: { args: [ptr, ptr, u32], returns: ptr },
    QueryServiceConfigW: { args: [ptr, ptr, u32, ptr], returns: i32 },
    QueryServiceStatusEx: { args: [ptr, u32, ptr, u32, ptr], returns: i32 },
    RegisterServiceCtrlHandlerExW: { args: [ptr, ptr, ptr], returns: ptr },
    SetServiceObjectSecurity: { args: [ptr, u32, ptr], returns: i32 },
    SetServiceStatus: { args: [ptr, ptr], returns: i32 },
    StartServiceW: { args: [ptr, u32, ptr], returns: i32 },
  }),
);

const kernel32 = load(() =>
  dlopen("kernel32.dll", {
    AssignProcessToJobObject: { args: [ptr, ptr], returns: i32 },
    CloseHandle: { args: [ptr], returns: i32 },
    CreateJobObjectW: { args: [ptr, ptr], returns: ptr },
    FormatMessageW: {
      args: [u32, ptr, u32, u32, ptr, u32, ptr],
      returns: u32,
    },
    GetConsoleMode: { args: [ptr, ptr], returns: i32 },
    GetCurrentProcess: { args: [], returns: ptr },
    GetLastError: { args: [], returns: u32 },
    GetStdHandle: { args: [i32], returns: ptr },
    LocalFree: { args: [ptr], returns: ptr },
    OpenProcess: { args: [u32, i32, u32], returns: ptr },
    SetConsoleMode: { args: [ptr, u32], returns: i32 },
    SetLastError: { args: [u32], returns: FFIType.void },
    SetInformationJobObject: { args: [ptr, u32, ptr, u32], returns: i32 },
    TerminateJobObject: { args: [ptr, u32], returns: i32 },
  }),
);

const secur32 = load(() =>
  dlopen("secur32.dll", {
    GetUserNameExW: { args: [u32, ptr, ptr], returns: i32 },
  }),
);

/** A Win32 failure, with the code the callers tell apart and the call that failed. */
export class WindowsError extends Error {
  readonly code: number;
  /** The function that failed, like `CreateServiceW`; absent for a message written for a person. */
  readonly call: string | undefined;

  constructor(message: string, code: number, call?: string) {
    super(message);
    this.code = code;
    this.call = call;
  }
}

export const ERROR_ACCESS_DENIED = 5;
export const ERROR_LOGON_FAILURE = 1326;
const ERROR_ACCOUNT_RESTRICTION = 1327;
const ERROR_SERVICE_ALREADY_RUNNING = 1056;
const ERROR_SERVICE_CANNOT_ACCEPT_CTRL = 1061;
const ERROR_SERVICE_NOT_ACTIVE = 1062;
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
const ERROR_SERVICE_LOGON_FAILED = 1069;
const ERROR_SERVICE_MARKED_FOR_DELETE = 1072;

/** The names of the codes these calls are known to give, as `winerror.h` spells them. */
const ERROR_NAMES: Readonly<Record<number, string>> = {
  2: "ERROR_FILE_NOT_FOUND",
  5: "ERROR_ACCESS_DENIED",
  6: "ERROR_INVALID_HANDLE",
  87: "ERROR_INVALID_PARAMETER",
  122: "ERROR_INSUFFICIENT_BUFFER",
  1051: "ERROR_DEPENDENT_SERVICES_RUNNING",
  1052: "ERROR_INVALID_SERVICE_CONTROL",
  1053: "ERROR_SERVICE_REQUEST_TIMEOUT",
  1056: "ERROR_SERVICE_ALREADY_RUNNING",
  1057: "ERROR_INVALID_SERVICE_ACCOUNT",
  1058: "ERROR_SERVICE_DISABLED",
  1060: "ERROR_SERVICE_DOES_NOT_EXIST",
  1061: "ERROR_SERVICE_CANNOT_ACCEPT_CTRL",
  1062: "ERROR_SERVICE_NOT_ACTIVE",
  1063: "ERROR_FAILED_SERVICE_CONTROLLER_CONNECT",
  1069: "ERROR_SERVICE_LOGON_FAILED",
  1072: "ERROR_SERVICE_MARKED_FOR_DELETE",
  1073: "ERROR_SERVICE_EXISTS",
  1078: "ERROR_DUPLICATE_SERVICE_NAME",
  1115: "ERROR_SHUTDOWN_IN_PROGRESS",
  1326: "ERROR_LOGON_FAILURE",
  1327: "ERROR_ACCOUNT_RESTRICTION",
  1385: "ERROR_LOGON_TYPE_NOT_GRANTED",
};

const SC_MANAGER_CONNECT = 0x1;
const SC_MANAGER_ALL_ACCESS = 0xf003f;
const SERVICE_QUERY_CONFIG = 0x1;
const SERVICE_CHANGE_CONFIG = 0x2;
const SERVICE_QUERY_STATUS = 0x4;
const SERVICE_START = 0x10;
const SERVICE_STOP = 0x20;
const DELETE = 0x10000;
const WRITE_DAC = 0x40000;
const SERVICE_WIN32_OWN_PROCESS = 0x10;
const SERVICE_AUTO_START = 2;
const SERVICE_DEMAND_START = 3;
const SERVICE_ERROR_NORMAL = 1;
const SERVICE_NO_CHANGE = 0xffffffff;
const SERVICE_CONTROL_STOP = 1;
const SERVICE_CONFIG_DESCRIPTION = 1;
const SERVICE_CONFIG_FAILURE_ACTIONS = 2;
const SC_ACTION_RESTART = 1;
const DACL_SECURITY_INFORMATION = 4;
const SDDL_REVISION_1 = 1;
const STATUS_PROCESS_INFO = 0;
const SERVICE_STATUS_PROCESS_SIZE = 36;

const TOKEN_QUERY = 0x8;
const TOKEN_USER = 1;
const TOKEN_ELEVATION = 20;
const NAME_SAM_COMPATIBLE = 2;
const LOGON_INTERACTIVE = 2;
const LOGON_PROVIDER_DEFAULT = 0;
const POLICY_ACCESS = 0x810; // POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES
const SERVICE_LOGON_RIGHT = "SeServiceLogonRight";

const JOB_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_LIMITS_SIZE = 144;
const JOB_LIMIT_FLAGS_OFFSET = 16;
const PROCESS_SET_QUOTA = 0x100;
const PROCESS_TERMINATE = 0x1;

const STD_INPUT_HANDLE = -10;
const ENABLE_ECHO_INPUT = 0x4;

/** Text as Windows takes it. The caller keeps it alive across the call by holding the array. */
export const wide = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(`${text}\0`, "utf16le"));

/** A NUL-terminated UTF-16 string at an address Windows handed back. */
function wideAt(address: number): string {
  let length = 0;
  while (read.u16(address as never, length) !== 0) length += 2;
  return Buffer.from(toArrayBuffer(address as never, 0, length)).toString(
    "utf16le",
  );
}

/** One pointer-sized out parameter. */
const out = (): BigUint64Array => new BigUint64Array(1);
const handleIn = (slot: BigUint64Array): number => Number(slot[0]);

/**
 * Calls a Win32 function and reads its `GetLastError` in native code, at once. Read with a second
 * `bun:ffi` call it is not the call's: a garbage collection or a turn of the event loop in between
 * runs Windows calls of Bun's own on this thread, and those set it, mostly to 0 (#367). The error is
 * cleared first, so a 0 here means the call failed without saying why.
 *
 * What it can call: the shim passes every function 13 64-bit integer slots and takes a 64-bit
 * integer back. That is right for a function that takes at most 13 arguments, each an integer, a
 * handle or a pointer, and returns one of those, in the 64-bit Windows convention, where those go in
 * RCX, RDX, R8, R9 and then the stack, and the caller owns the stack. It is wrong for a function
 * that takes or returns a float or a double (those go in XMM registers, which the shim leaves
 * unset), takes a struct by value, or is variadic like `wsprintfW`: call those directly, and read
 * their errors some other way.
 */
const SHIM = String.raw`
typedef unsigned long long u64;
typedef u64 (*win32_call)(u64, u64, u64, u64, u64, u64, u64, u64, u64, u64, u64, u64, u64);
static unsigned int (*get_last_error)(void);
static void (*set_last_error)(unsigned int);

void bind_errors(void *get, void *set) {
  get_last_error = (unsigned int (*)(void))get;
  set_last_error = (void (*)(unsigned int))set;
}

static u64 invoke(void *f, unsigned int *code, u64 a0, u64 a1, u64 a2, u64 a3, u64 a4, u64 a5,
                  u64 a6, u64 a7, u64 a8, u64 a9, u64 a10, u64 a11, u64 a12) {
  set_last_error(0);
  u64 result = ((win32_call)f)(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12);
  *code = get_last_error();
  return result;
}

void *call_pointer(void *f, unsigned int *code, u64 a0, u64 a1, u64 a2, u64 a3, u64 a4, u64 a5,
                   u64 a6, u64 a7, u64 a8, u64 a9, u64 a10, u64 a11, u64 a12) {
  return (void *)invoke(f, code, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12);
}

int call_int(void *f, unsigned int *code, u64 a0, u64 a1, u64 a2, u64 a3, u64 a4, u64 a5,
             u64 a6, u64 a7, u64 a8, u64 a9, u64 a10, u64 a11, u64 a12) {
  return (int)invoke(f, code, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12);
}
`;

type Arg = number | Pointer | null | NodeJS.TypedArray;
type Native = (...args: never[]) => unknown;

/** Where a `dlopen`ed function is: Bun puts it on the function, and its types leave it out. */
const pointerOf = (fn: Native): Pointer =>
  (fn as unknown as { ptr: Pointer }).ptr;

/** Every Win32 function here takes at most this many arguments: the rest are passed as 0. */
const SHIM_ARGS = 13;

const shimCall = {
  args: Array.from<FFIType>({ length: SHIM_ARGS + 2 }).fill(ptr),
};
const SHIM_SYMBOLS = {
  bind_errors: { args: [ptr, ptr], returns: FFIType.void },
  call_pointer: { ...shimCall, returns: ptr },
  call_int: { ...shimCall, returns: i32 },
} satisfies Record<string, FFIFunction>;
type ShimSymbols = Library<typeof SHIM_SYMBOLS>["symbols"];

/**
 * Set to 1 where a build must use the shim: a call then throws when it did not compile, instead of
 * reading its code the old way. The Windows CI jobs set it, so a build that loses the shim fails
 * there rather than going back quietly to the codes #367 lost.
 */
const REQUIRE_SHIM = "ETA_REQUIRE_WIN32_SHIM";

/**
 * The shim, compiled by Bun's TinyCC, or why it was not. In the 64-bit Windows convention the
 * caller owns the arguments, so a function called with more than it takes ignores the rest.
 */
const shim = load((): { symbols: ShimSymbols } | { failed: string } => {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "eta-ffi-"));
    const source = join(dir, "last-error.c");
    writeFileSync(source, SHIM);
    const { symbols } = cc({ source, symbols: SHIM_SYMBOLS });
    const { GetLastError, SetLastError } = kernel32().symbols;
    symbols.bind_errors(pointerOf(GetLastError), pointerOf(SetLastError));
    return { symbols };
  } catch (error) {
    const failed = error instanceof Error ? error.message : String(error);
    if (process.env[REQUIRE_SHIM] !== "1")
      console.warn(
        `eta: the Windows error-code shim did not compile (${failed}): a failed Windows call's error code is read after it, and may come back as 0`,
      );
    return { failed };
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A file in the temporary folder.
      }
    }
  }
});

/** What a call gave back, 0 for a null handle, and its error, read when it returned. */
interface Called {
  value: number;
  code: number;
}

const codeSlot = new Uint32Array(1);

function invoke(
  returns: "pointer" | "int",
  fn: Native,
  args: readonly Arg[],
): Called {
  const compiled = shim();
  if ("failed" in compiled) {
    if (process.env[REQUIRE_SHIM] === "1")
      throw new Error(
        `the Windows error-code shim did not compile, and ${REQUIRE_SHIM}=1: ${compiled.failed}`,
      );
    const value = (fn as (...given: Arg[]) => number | null)(...args) ?? 0;
    return { value, code: lastCode() };
  }
  const native = compiled.symbols;
  const padded = [...args];
  while (padded.length < SHIM_ARGS) padded.push(0);
  codeSlot[0] = 0;
  const call = returns === "pointer" ? native.call_pointer : native.call_int;
  const value =
    (call as (...given: Arg[]) => number | null)(
      pointerOf(fn),
      codeSlot,
      ...padded,
    ) ?? 0;
  return { value, code: codeSlot[0] as number };
}

/** A function that returns a handle, null when it fails. */
const callHandle = (fn: Native, ...args: Arg[]): Called =>
  invoke("pointer", fn, args);
/** A function that returns a `BOOL`, 0 when it fails. */
const callBool = (fn: Native, ...args: Arg[]): Called =>
  invoke("int", fn, args);

function lastCode(): number {
  const { GetLastError: code } = kernel32().symbols;
  return code();
}

/** What Windows says a code is, in its own language: for the codes not in ERROR_NAMES. */
function systemText(code: number): string {
  const FORMAT_MESSAGE_FROM_SYSTEM = 0x1000;
  const FORMAT_MESSAGE_IGNORE_INSERTS = 0x200;
  try {
    const text = new Uint16Array(512);
    const length = kernel32().symbols.FormatMessageW(
      FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
      null,
      code,
      0,
      text,
      text.length,
      null,
    );
    return Buffer.from(text.buffer, 0, length * 2)
      .toString("utf16le")
      .trim()
      .replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** `1072 ERROR_SERVICE_MARKED_FOR_DELETE`, or the number with what Windows calls it. */
function explainCode(code: number): string {
  if (code === 0) return "0 (the call failed without setting an error code)";
  const name = ERROR_NAMES[code];
  if (name !== undefined) return `${code} ${name}`;
  const text = systemText(code);
  return text === "" ? String(code) : `${code} (${text})`;
}

/** `CreateServiceW(io.eta.host) failed: 1072 ERROR_SERVICE_MARKED_FOR_DELETE` */
export const callFailed = (
  call: string,
  code: number,
  subject?: string,
): WindowsError =>
  new WindowsError(
    `${call}${subject === undefined ? "" : `(${subject})`} failed: ${explainCode(code)}`,
    code,
    call,
  );

function fail(call: string, code: number, subject?: string): never {
  throw callFailed(call, code, subject);
}

/** The handle `fn` gives, or a WindowsError naming `call`. */
function handleFrom(
  call: string,
  subject: string | undefined,
  fn: Native,
  ...args: Arg[]
): number {
  const { value, code } = callHandle(fn, ...args);
  if (value === 0) fail(call, code, subject);
  return value;
}

/** Calls a `BOOL` function, and fails with a WindowsError naming `call` when it does. */
function succeed(
  call: string,
  subject: string | undefined,
  fn: Native,
  ...args: Arg[]
): void {
  const { value, code } = callBool(fn, ...args);
  if (value === 0) fail(call, code, subject);
}

interface ServiceStatus {
  state: number;
  exitCode: number;
  pid: number;
}

const STATES: Readonly<Record<number, string>> = {
  1: "stopped",
  2: "start-pending",
  3: "stop-pending",
  4: "running",
  5: "continue-pending",
  6: "pause-pending",
  7: "paused",
};

interface ServiceAnswer {
  installed: boolean;
  state?: string;
  pid?: number;
  /** What Windows has it run as. */
  account?: string;
}

/**
 * A service, opened with only the rights asked for: that is what lets the user who installed it do
 * this without being an Administrator.
 */
function withService<T>(
  name: string,
  access: number,
  action: (service: number) => T,
): T {
  const { CloseServiceHandle, OpenSCManagerW, OpenServiceW } =
    advapi32().symbols;
  const manager = handleFrom(
    "OpenSCManagerW",
    undefined,
    OpenSCManagerW,
    null,
    null,
    SC_MANAGER_CONNECT,
  );
  try {
    const service = handleFrom(
      "OpenServiceW",
      name,
      OpenServiceW,
      manager,
      wide(name),
      access,
    );
    try {
      return action(service);
    } finally {
      CloseServiceHandle(service as never);
    }
  } finally {
    CloseServiceHandle(manager as never);
  }
}

function statusOf(service: number): ServiceStatus {
  const fields = new Uint32Array(SERVICE_STATUS_PROCESS_SIZE / 4);
  const needed = new Uint32Array(1);
  succeed(
    "QueryServiceStatusEx",
    undefined,
    advapi32().symbols.QueryServiceStatusEx,
    service,
    STATUS_PROCESS_INFO,
    fields,
    SERVICE_STATUS_PROCESS_SIZE,
    needed,
  );
  return {
    state: fields[1] as number,
    exitCode: fields[3] as number,
    pid: fields[7] as number,
  };
}

function accountOf(service: number): string {
  const { QueryServiceConfigW } = advapi32().symbols;
  const needed = new Uint32Array(1);
  QueryServiceConfigW(service as never, null, 0, needed);
  const buffer = new BigUint64Array(Math.ceil((needed[0] as number) / 8));
  succeed(
    "QueryServiceConfigW",
    undefined,
    QueryServiceConfigW,
    service,
    buffer,
    buffer.byteLength,
    needed,
  );
  // lpServiceStartName in QUERY_SERVICE_CONFIGW.
  return wideAt(Number(buffer[6]));
}

export function queryService(name: string): ServiceAnswer {
  try {
    return withService(
      name,
      SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG,
      (service) => {
        const { pid, state } = statusOf(service);
        return {
          installed: true,
          state: STATES[state] ?? String(state),
          pid,
          account: accountOf(service),
        };
      },
    );
  } catch (error) {
    if (
      error instanceof WindowsError &&
      error.code === ERROR_SERVICE_DOES_NOT_EXIST
    )
      return { installed: false };
    throw error;
  }
}

/** Asks Windows to start it; `queryService` says how that went. */
export function startService(name: string): void {
  withService(name, SERVICE_START, (service) => {
    const { value, code } = callBool(
      advapi32().symbols.StartServiceW,
      service,
      0,
      null,
    );
    if (value !== 0 || code === ERROR_SERVICE_ALREADY_RUNNING) return;
    if (code === ERROR_SERVICE_LOGON_FAILED)
      throw new WindowsError(
        `${name} cannot log on: the password has changed since it was installed. Run uninstall-service and install-service again in an Administrator terminal`,
        code,
        "StartServiceW",
      );
    fail("StartServiceW", code, name);
  });
}

/** Tells it to stop, and that is all: one that is not running is stopped. */
export function stopService(name: string): void {
  withService(name, SERVICE_STOP, (service) => {
    const ignored = new Uint32Array(7);
    const { value, code } = callBool(
      advapi32().symbols.ControlService,
      service,
      SERVICE_CONTROL_STOP,
      ignored,
    );
    if (value !== 0) return;
    if (
      code !== ERROR_SERVICE_NOT_ACTIVE &&
      code !== ERROR_SERVICE_CANNOT_ACCEPT_CTRL
    )
      fail("ControlService", code, name);
  });
}

/** The account running this, as Windows names it to a service, and its SID. */
export function currentUser(): { account: string; sid: string } {
  const { CloseHandle, GetCurrentProcess } = kernel32().symbols;
  const { ConvertSidToStringSidW, GetTokenInformation, OpenProcessToken } =
    advapi32().symbols;
  const size = new Uint32Array([256]);
  const name = new Uint16Array(256);
  succeed(
    "GetUserNameExW",
    undefined,
    secur32().symbols.GetUserNameExW,
    NAME_SAM_COMPATIBLE,
    name,
    size,
  );
  const account = Buffer.from(name.buffer, 0, (size[0] as number) * 2).toString(
    "utf16le",
  );
  const token = out();
  succeed(
    "OpenProcessToken",
    undefined,
    OpenProcessToken,
    GetCurrentProcess() as number,
    TOKEN_QUERY,
    token,
  );
  try {
    const user = new BigUint64Array(16);
    const needed = new Uint32Array(1);
    succeed(
      "GetTokenInformation",
      "TokenUser",
      GetTokenInformation,
      handleIn(token),
      TOKEN_USER,
      user,
      user.byteLength,
      needed,
    );
    const text = out();
    succeed(
      "ConvertSidToStringSidW",
      undefined,
      ConvertSidToStringSidW,
      Number(user[0]),
      text,
    );
    const sid = wideAt(handleIn(text));
    kernel32().symbols.LocalFree(handleIn(text) as never);
    return { account, sid };
  } finally {
    CloseHandle(handleIn(token) as never);
  }
}

export function isElevated(): boolean {
  const { CloseHandle, GetCurrentProcess } = kernel32().symbols;
  const { GetTokenInformation, OpenProcessToken } = advapi32().symbols;
  const token = out();
  succeed(
    "OpenProcessToken",
    undefined,
    OpenProcessToken,
    GetCurrentProcess() as number,
    TOKEN_QUERY,
    token,
  );
  try {
    const elevated = new Uint32Array(1);
    const needed = new Uint32Array(1);
    succeed(
      "GetTokenInformation",
      "TokenElevation",
      GetTokenInformation,
      handleIn(token),
      TOKEN_ELEVATION,
      elevated,
      4,
      needed,
    );
    return elevated[0] !== 0;
  } finally {
    CloseHandle(handleIn(token) as never);
  }
}

/**
 * Whether this is the account's password, here and not at the first start. A local account's
 * domain is the computer, which is how `currentUser` names it. Only a wrong password stops things:
 * a policy that forbids this kind of logon says nothing about the service's.
 */
export function checkPassword(account: string, password: Uint8Array): void {
  const at = account.indexOf("\\");
  const domain = at < 0 ? "." : account.slice(0, at);
  const user = at < 0 ? account : account.slice(at + 1);
  const token = out();
  const { value, code } = callBool(
    advapi32().symbols.LogonUserW,
    wide(user),
    wide(domain),
    password,
    LOGON_INTERACTIVE,
    LOGON_PROVIDER_DEFAULT,
    token,
  );
  if (value !== 0) {
    kernel32().symbols.CloseHandle(handleIn(token) as never);
    return;
  }
  if (code === ERROR_LOGON_FAILURE)
    throw new WindowsError(
      `that is not the password of ${account}`,
      code,
      "LogonUserW",
    );
  if (code === ERROR_ACCOUNT_RESTRICTION)
    throw new WindowsError(
      `${account} has no password, and Windows does not start services with an empty one. Set one, or use the password of the Microsoft account it signs in with`,
      code,
      "LogonUserW",
    );
}

/** An `LSA_UNICODE_STRING`, with the text it points at held in the second. */
function lsaString(text: string): [BigUint64Array, Uint8Array] {
  const bytes = wide(text);
  const length = BigInt(bytes.length - 2);
  const string = new BigUint64Array(2);
  string[0] = length | ((length + 2n) << 16n);
  string[1] = BigInt(addressOf(bytes));
  return [string, bytes];
}

function lsaFail(what: string, status: number): never {
  const { LsaNtStatusToWinError: win32Code } = advapi32().symbols;
  fail(what, win32Code(status));
}

function withPolicy<T>(
  action: (policy: number, sid: number) => T,
  sid: string,
) {
  const { ConvertStringSidToSidW, LsaClose, LsaOpenPolicy } =
    advapi32().symbols;
  const binary = out();
  succeed(
    "ConvertStringSidToSidW",
    sid,
    ConvertStringSidToSidW,
    wide(sid),
    binary,
  );
  const attributes = new BigUint64Array(6);
  attributes[0] = BigInt(attributes.byteLength);
  const policy = out();
  const status = LsaOpenPolicy(null, attributes, POLICY_ACCESS, policy);
  if (status !== 0) lsaFail("LsaOpenPolicy", status);
  try {
    return action(handleIn(policy), handleIn(binary));
  } finally {
    LsaClose(handleIn(policy) as never);
    kernel32().symbols.LocalFree(handleIn(binary) as never);
  }
}

function hasLogonRight(policy: number, sid: number): boolean {
  const { LsaEnumerateAccountRights, LsaFreeMemory } = advapi32().symbols;
  const rights = out();
  const count = new Uint32Array(1);
  const status = LsaEnumerateAccountRights(
    policy as never,
    sid as never,
    rights,
    count,
  );
  // An account with no rights at all is an error here, not an empty list.
  if (status !== 0) return false;
  try {
    for (let index = 0; index < (count[0] as number); index += 1) {
      const entry = handleIn(rights) + index * 16;
      const text = wideAt(Number(read.u64(entry as never, 8)));
      if (text === SERVICE_LOGON_RIGHT) return true;
    }
    return false;
  } finally {
    LsaFreeMemory(handleIn(rights) as never);
  }
}

/** Whether it gave the right: an account may have it already, and keeps it after an uninstall. */
export function grantLogonRight(sid: string): boolean {
  return withPolicy((policy, binary) => {
    if (hasLogonRight(policy, binary)) return false;
    const [right, text] = lsaString(SERVICE_LOGON_RIGHT);
    const status = advapi32().symbols.LsaAddAccountRights(
      policy as never,
      binary as never,
      right,
      1,
    );
    text.fill(0);
    if (status !== 0) lsaFail("LsaAddAccountRights", status);
    return true;
  }, sid);
}

export function revokeLogonRight(sid: string): void {
  withPolicy((policy, binary) => {
    const [right] = lsaString(SERVICE_LOGON_RIGHT);
    const status = advapi32().symbols.LsaRemoveAccountRights(
      policy as never,
      binary as never,
      0,
      right,
      1,
    );
    if (status !== 0) lsaFail("LsaRemoveAccountRights", status);
  }, sid);
}

/**
 * What a service lets who do: the defaults, and for the installing user what `eta-host upgrade` and
 * the page's button need, query, start and stop. A service cannot ask for elevation.
 */
const serviceDescriptor = (user: string): string =>
  "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)" +
  "(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)" +
  "(A;;CCLCSWLOCRRC;;;IU)" +
  "(A;;CCLCSWLOCRRC;;;SU)" +
  `(A;;CCLCSWRPWPLOCRRC;;;${user})`;

interface Registration {
  name: string;
  display: string;
  /** The whole command line, quoted. */
  command: string;
  /** At boot, or only when something starts it. */
  automatic: boolean;
  account: string;
  /** Empty when the service exists and keeps the one it has. */
  password: Uint8Array | undefined;
  sid: string;
  /** Start it again this long after it dies, if it does. */
  restartMs: number;
}

function secure(service: number, descriptor: string): void {
  const { ConvertStringSecurityDescriptorToSecurityDescriptorW, ...symbols } =
    advapi32().symbols;
  const parsed = out();
  succeed(
    "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    undefined,
    ConvertStringSecurityDescriptorToSecurityDescriptorW,
    wide(descriptor),
    SDDL_REVISION_1,
    parsed,
    null,
  );
  try {
    succeed(
      "SetServiceObjectSecurity",
      undefined,
      symbols.SetServiceObjectSecurity,
      service,
      DACL_SECURITY_INFORMATION,
      handleIn(parsed),
    );
  } finally {
    kernel32().symbols.LocalFree(handleIn(parsed) as never);
  }
}

/** A `SERVICE_FAILURE_ACTIONSW`: restart, for ever. What is restarted is the shell, not the host. */
function restartOnFailure(service: number, delayMs: number): void {
  const action = new Uint32Array([SC_ACTION_RESTART, delayMs]);
  const actions = new BigUint64Array(5);
  actions[0] = 86_400n;
  actions[3] = 1n;
  actions[4] = BigInt(addressOf(action));
  succeed(
    "ChangeServiceConfig2W",
    "SERVICE_CONFIG_FAILURE_ACTIONS",
    advapi32().symbols.ChangeServiceConfig2W,
    service,
    SERVICE_CONFIG_FAILURE_ACTIONS,
    actions,
  );
}

function describeService(service: number, text: string): void {
  const description = wide(text);
  const pointer = BigUint64Array.of(BigInt(addressOf(description)));
  succeed(
    "ChangeServiceConfig2W",
    "SERVICE_CONFIG_DESCRIPTION",
    advapi32().symbols.ChangeServiceConfig2W,
    service,
    SERVICE_CONFIG_DESCRIPTION,
    pointer,
  );
}

/**
 * Creates the service, or points the one there at the new command, keeping its account and password.
 * Takes an Administrator. A WindowsError, returned and not thrown, when a deleted one of this name
 * has not gone yet: try again, and say that error if it never goes.
 */
export function registerService(
  registration: Registration,
): WindowsError | undefined {
  const { account, command, display, name, password, sid } = registration;
  const { ChangeServiceConfigW, CloseServiceHandle, CreateServiceW } =
    advapi32().symbols;
  const { OpenSCManagerW, OpenServiceW } = advapi32().symbols;
  const manager = handleFrom(
    "OpenSCManagerW",
    undefined,
    OpenSCManagerW,
    null,
    null,
    SC_MANAGER_ALL_ACCESS,
  );
  try {
    // A failure action that restarts takes the right to start, as well as to change.
    const access = SERVICE_CHANGE_CONFIG | SERVICE_START | WRITE_DAC;
    const opened = callHandle(OpenServiceW, manager, wide(name), access);
    let service = opened.value;
    if (service === 0) {
      if (opened.code !== ERROR_SERVICE_DOES_NOT_EXIST)
        fail("OpenServiceW", opened.code, name);
      const created = callHandle(
        CreateServiceW,
        manager,
        wide(name),
        wide(display),
        access,
        SERVICE_WIN32_OWN_PROCESS,
        registration.automatic ? SERVICE_AUTO_START : SERVICE_DEMAND_START,
        SERVICE_ERROR_NORMAL,
        wide(command),
        null,
        null,
        null,
        wide(account),
        password ?? null,
      );
      if (created.value === 0) {
        const error = callFailed("CreateServiceW", created.code, name);
        if (created.code === ERROR_SERVICE_MARKED_FOR_DELETE) return error;
        throw error;
      }
      service = created.value;
    } else {
      const changed = callBool(
        ChangeServiceConfigW,
        service,
        SERVICE_NO_CHANGE,
        SERVICE_NO_CHANGE,
        SERVICE_NO_CHANGE,
        wide(command),
        null,
        null,
        null,
        null,
        null,
        null,
      );
      if (changed.value === 0) {
        CloseServiceHandle(service as never);
        fail("ChangeServiceConfigW", changed.code, name);
      }
    }
    try {
      describeService(service, display);
      secure(service, serviceDescriptor(sid));
      if (registration.automatic)
        restartOnFailure(service, registration.restartMs);
    } finally {
      CloseServiceHandle(service as never);
    }
    return undefined;
  } finally {
    CloseServiceHandle(manager as never);
  }
}

/** Marks it for deletion; Windows removes it when the last handle on it closes. */
export function deleteService(name: string): void {
  try {
    withService(name, DELETE, (service) => {
      succeed("DeleteService", name, advapi32().symbols.DeleteService, service);
    });
  } catch (error) {
    const gone =
      error instanceof WindowsError &&
      (error.code === ERROR_SERVICE_DOES_NOT_EXIST ||
        error.code === ERROR_SERVICE_MARKED_FOR_DELETE);
    if (!gone) throw error;
  }
}

/** Runs `action` with what is typed on the console not shown; the console is put back after. */
export async function withoutEcho<T>(action: () => Promise<T>): Promise<T> {
  const { GetConsoleMode, GetStdHandle, SetConsoleMode } = kernel32().symbols;
  const input = GetStdHandle(STD_INPUT_HANDLE);
  const mode = new Uint32Array(1);
  if (GetConsoleMode(input, mode) === 0) return action();
  SetConsoleMode(input, (mode[0] as number) & ~ENABLE_ECHO_INPUT);
  try {
    return await action();
  } finally {
    SetConsoleMode(input, mode[0] as number);
  }
}

/** Whether stdin is a person at a console, who can be asked again. */
export function stdinIsConsole(): boolean {
  const { GetConsoleMode, GetStdHandle } = kernel32().symbols;
  return (
    GetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), new Uint32Array(1)) !== 0
  );
}

/**
 * A job that kills what is in it when its last handle closes, however this process ends: nothing
 * the host started outlives the service.
 */
export function createKillJob(): number {
  const { CreateJobObjectW, SetInformationJobObject } = kernel32().symbols;
  const job = handleFrom(
    "CreateJobObjectW",
    undefined,
    CreateJobObjectW,
    null,
    null,
  );
  const limits = new DataView(new ArrayBuffer(JOB_LIMITS_SIZE));
  limits.setUint32(JOB_LIMIT_FLAGS_OFFSET, JOB_LIMIT_KILL_ON_JOB_CLOSE, true);
  succeed(
    "SetInformationJobObject",
    undefined,
    SetInformationJobObject,
    job,
    JOB_EXTENDED_LIMIT_INFORMATION,
    new Uint8Array(limits.buffer),
    JOB_LIMITS_SIZE,
  );
  return job;
}

export function assignToJob(job: number, pid: number): void {
  const { AssignProcessToJobObject, CloseHandle, OpenProcess } =
    kernel32().symbols;
  const process = handleFrom(
    "OpenProcess",
    String(pid),
    OpenProcess,
    PROCESS_SET_QUOTA | PROCESS_TERMINATE,
    0,
    pid,
  );
  try {
    succeed(
      "AssignProcessToJobObject",
      String(pid),
      AssignProcessToJobObject,
      job,
      process,
    );
  } finally {
    CloseHandle(process as never);
  }
}

export function terminateJob(job: number, code: number): void {
  kernel32().symbols.TerminateJobObject(job as never, code);
}

/** The controls that end a service. */
export const STOP_CONTROLS: ReadonlySet<number> = new Set([1, 5, 15]);

const SERVICE_ACCEPT_STOP = 0x1;
const SERVICE_ACCEPT_SHUTDOWN = 0x4;
const SERVICE_ACCEPT_PRESHUTDOWN = 0x100;
export const SERVICE_STOPPED = 1;
export const SERVICE_STOP_PENDING = 3;
export const SERVICE_RUNNING = 4;
const STOP_WAIT_HINT_MS = 10_000;

/** The running service's handle on itself, and how it tells Windows where it is. */
export function registerControls(
  name: Uint8Array,
  handler: number,
): (state: number, checkpoint: number) => void {
  const { RegisterServiceCtrlHandlerExW, SetServiceStatus } =
    advapi32().symbols;
  const status = handleFrom(
    "RegisterServiceCtrlHandlerExW",
    undefined,
    RegisterServiceCtrlHandlerExW,
    name,
    handler,
    null,
  );
  return (state, checkpoint) => {
    const fields = new Uint32Array([
      SERVICE_WIN32_OWN_PROCESS,
      state,
      state === SERVICE_RUNNING
        ? SERVICE_ACCEPT_STOP |
          SERVICE_ACCEPT_SHUTDOWN |
          SERVICE_ACCEPT_PRESHUTDOWN
        : 0,
      0,
      0,
      checkpoint,
      state === SERVICE_STOP_PENDING ? STOP_WAIT_HINT_MS : 0,
    ]);
    SetServiceStatus(status as never, fields);
  };
}

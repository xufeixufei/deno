// Copyright 2018 the Deno authors. All rights reserved. MIT license.
// We need to make sure this module loads, for its side effects.
import { window } from "./globals";

import * as flatbuffers from "./flatbuffers";
import * as msg from "gen/msg_generated";
import { assert, log, setLogDebug } from "./util";
import * as os from "./os";
import { Compiler } from "./compiler";
import { Runner } from "./runner";
import { libdeno } from "./libdeno";
import { args } from "./deno";
import { sendSync, handleAsyncMsgFromRust } from "./dispatch";
import { promiseErrorExaminer, promiseRejectHandler } from "./promise_util";
import { replLoop } from "./repl";
import * as sourceMaps from "./v8_source_maps";
import { version } from "typescript";

// Install the source maps handler and do some pre-calculations so all of it is
// available in the snapshot
const compiler = Compiler.instance();
sourceMaps.install({
  installPrepareStackTrace: true,
  getGeneratedContents: compiler.getGeneratedContents
});
const consumer = sourceMaps.loadConsumer("gen/bundle/main.js");
assert(consumer != null);
consumer!.computeColumnSpans();

function sendStart(): msg.StartRes {
  const builder = flatbuffers.createBuilder();
  msg.Start.startStart(builder);
  const startOffset = msg.Start.endStart(builder);
  const baseRes = sendSync(builder, msg.Any.Start, startOffset);
  assert(baseRes != null);
  assert(msg.Any.StartRes === baseRes!.innerType());
  const startRes = new msg.StartRes();
  assert(baseRes!.inner(startRes) != null);
  return startRes;
}

function onGlobalError(
  message: string,
  source: string,
  lineno: number,
  colno: number,
  error: any // tslint:disable-line:no-any
) {
  if (error instanceof Error) {
    console.log(error.stack);
  } else {
    console.log(`Thrown: ${String(error)}`);
  }
  os.exit(1);
}

function denoMain() {
  libdeno.recv(handleAsyncMsgFromRust);
  libdeno.setGlobalErrorHandler(onGlobalError);
  libdeno.setPromiseRejectHandler(promiseRejectHandler);
  libdeno.setPromiseErrorExaminer(promiseErrorExaminer);

  // First we send an empty "Start" message to let the privileged side know we
  // are ready. The response should be a "StartRes" message containing the CLI
  // args and other info.
  const startResMsg = sendStart();

  setLogDebug(startResMsg.debugFlag());

  // handle `--types`
  if (startResMsg.typesFlag()) {
    const defaultLibFileName = compiler.getDefaultLibFileName();
    console.log(compiler.getSource(defaultLibFileName));
    os.exit(0);
  }

  // handle `--version`
  if (startResMsg.versionFlag()) {
    console.log("deno:", startResMsg.denoVersion());
    console.log("v8:", startResMsg.v8Version());
    console.log("typescript:", version);
    os.exit(0);
  }

  const cwd = startResMsg.cwd();
  log("cwd", cwd);

  for (let i = 1; i < startResMsg.argvLength(); i++) {
    args.push(startResMsg.argv(i));
  }
  log("args", args);
  Object.freeze(args);
  const inputFn = args[0];

  compiler.recompile = startResMsg.recompileFlag();
  const runner = new Runner(compiler);

  if (inputFn) {
    runner.run(inputFn, `${cwd}/`);
  } else {
    replLoop();
  }
}

// TODO(ry) denoMain needs to be accessable to src/main.rs - is there a way to do
// this without adding it to the global scope?
window["denoMain"] = denoMain;

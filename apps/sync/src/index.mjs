// entry point — load env, create store, boot daemon
import "./env.mjs";
import { bootSyncDaemonFromSource } from "./boot-daemon.mjs";

bootSyncDaemonFromSource();

#!/usr/bin/env node
import { configMain } from "../config.js";

process.exitCode = await configMain();

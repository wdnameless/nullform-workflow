#!/usr/bin/env node
import { extractFinalAssistantResponse, scoreReview, writeScore } from "./common.mjs";
try { process.exitCode = writeScore("negative", scoreReview(extractFinalAssistantResponse().finalText, "negative")); }
catch (error) { process.exitCode = writeScore("negative", { requirementsSatisfied: false, error: error.message }); }

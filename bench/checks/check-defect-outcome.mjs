#!/usr/bin/env node
import { extractFinalAssistantResponse, scoreReview, writeScore } from "./common.mjs";
try { process.exitCode = writeScore("defect", scoreReview(extractFinalAssistantResponse().finalText, "defect")); }
catch (error) { process.exitCode = writeScore("defect", { requirementsSatisfied: false, error: error.message }); }

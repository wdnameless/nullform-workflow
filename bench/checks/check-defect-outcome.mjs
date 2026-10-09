#!/usr/bin/env node
import { extractFinalAssistantResponse, scoreReview, writeScore } from "../../tools/bench-results.mjs";
try { process.exitCode = writeScore("defect", scoreReview(extractFinalAssistantResponse().finalText, "defect")); }
catch (error) { process.exitCode = writeScore("defect", { requirementsSatisfied: false, error: error.message }); }

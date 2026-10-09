#!/usr/bin/env node
import { extractFinalAssistantResponse, scoreReview, writeScore } from "../../tools/bench-results.mjs";
try { process.exitCode = writeScore("positive", scoreReview(extractFinalAssistantResponse().finalText, "positive")); }
catch (error) { process.exitCode = writeScore("positive", { requirementsSatisfied: false, error: error.message }); }

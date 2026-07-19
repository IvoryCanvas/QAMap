#!/usr/bin/env node
// QAMap benchmark runner: scores plan/qa output quality against fixed PR
// scenarios. Targets can be pinned real repositories or committed fixtures.
// The runner never executes project code.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  formatAgentQaDraft,
  generateE2ePlan,
  generateQaDraft,
  writeVerificationManifestBaseline,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const explicitConfigPath = readArg("--config");
const configPath = explicitConfigPath ?? await defaultConfigPath();
const baselinePath = readArg("--baseline");
const save = args.includes("--save");
const assertContract = args.includes("--assert");
const resolvedConfigPath = path.resolve(configPath);
const configDir = path.dirname(resolvedConfigPath);
const config = JSON.parse(await fs.readFile(resolvedConfigPath, "utf8"));
const results = [];

for (const target of config.targets) {
  let prepared;
  try {
    prepared = await prepareTarget(target, configDir);
    const options = {
      base: prepared.base,
      head: prepared.head,
      workspaceRoot: prepared.workspaceRoot,
      manifestPath: prepared.manifestPath,
    };
    const startedAt = Date.now();
    const plan = await generateE2ePlan(prepared.root, options);
    const qa = await generateQaDraft(prepared.root, { ...options, runner: undefined });
    const durationMs = Date.now() - startedAt;
    const result = scoreTarget(target, plan, qa, durationMs);
    result.contractFailures = evaluateContract(target.expect ?? {}, result, plan, qa);
    result.contractPassed = result.contractFailures.length === 0;
    results.push(result);
  } catch (error) {
    results.push({
      name: target.name,
      error: String(error && error.message ? error.message : error),
      contractPassed: false,
      contractFailures: ["benchmark target could not be analyzed"],
    });
  } finally {
    await prepared?.cleanup?.();
  }
}

printTable(results);

if (baselinePath) {
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
  printDeltas(baseline.results ?? baseline, results);
}

if (save) {
  await fs.mkdir("bench-results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join("bench-results", `bench-${stamp}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify({ config: configPath, results }, null, 2)}\n`);
  console.log(`\nSaved: ${outputPath}`);
}

const failedTargets = results.filter((result) => !result.contractPassed);
if (assertContract && failedTargets.length > 0) {
  console.error(`\nBenchmark contract failed for ${failedTargets.length} target${failedTargets.length === 1 ? "" : "s"}.`);
  process.exitCode = 1;
}

function scoreTarget(target, plan, qa, durationMs) {
  const flowSteps = plan.flows.flatMap((flow) => flow.steps);
  const draftSteps = qa.flows.flatMap((flow) => flow.draftSteps ?? []);
  const allSteps = [...flowSteps, ...draftSteps];
  const blankActionPattern = /Fill\s{2,}|using \.\s*$|\s{2,}with realistic data/;
  const genericTitlePattern = /(?:primary journey|smoke flow|smoke checklist)$/i;
  const expect = target.expect ?? {};
  const flowFiles = new Set(plan.flows.flatMap((flow) => flow.files).map(normalizePath));
  const mustReach = (expect.mustReachFiles ?? []).map(normalizePath);
  const reached = mustReach.filter((file) => flowFiles.has(file));
  const flowTitles = qa.flows.map((flow) => flow.title);
  const planFlowTitles = plan.flows.map((flow) => flow.title);
  const successSignals = qa.flows
    .map((flow) => flow.userJourney?.successSignal)
    .filter(Boolean);
  const entrypoints = plan.flows.flatMap((flow) => flow.entrypoints.map((entrypoint) => entrypoint.value));
  const intentTitles = plan.changeAnalysis.intents.map((intent) => intent.title);
  const intentLifecycle = plan.changeAnalysis.intents.flatMap((intent) =>
    intent.lifecycle.map((stage) => `${stage.kind}: ${stage.label}`)
  );
  const intentScenarios = plan.changeAnalysis.intents.flatMap((intent) =>
    intent.scenarios.map((scenario) =>
      `${scenario.priority} ${scenario.kind}: ${scenario.title} ${scenario.assertions.join(" ")}`
    )
  );
  const qaScenarios = plan.changeAnalysis.intents.flatMap((intent) => intent.scenarios);
  const scenarioReceipts = [...new Map(
    qa.flows.flatMap((flow) => flow.scenarioAutomation ?? []).map((receipt) => [receipt.scenarioId, receipt]),
  ).values()];
  const scenarioReceiptIds = new Set(scenarioReceipts.map((receipt) => receipt.scenarioId));
  const reasoningTraceIds = new Set(qa.traces.map((trace) => trace.scenario.id));
  const locatedQaScenarios = qaScenarios.filter((scenario) =>
    scenario.evidence.some((item) =>
      item.kind === "diff" && item.file && item.startLine !== undefined && item.relation !== "contextual"
    )
  );
  const scenarioSourceFiles = [...new Set(locatedQaScenarios.flatMap((scenario) =>
    scenario.evidence
      .filter((item) =>
        item.kind === "diff" && item.file && item.startLine !== undefined && item.relation !== "contextual"
      )
      .map((item) => normalizePath(item.file))
  ))];
  const mustName = expect.mustNameFlows ?? [];
  const named = mustName.filter((name) => includesTerm(flowTitles, name));
  const existingEvidencePaths = qa.flows.flatMap((flow) => flow.existingEvidencePaths ?? []);

  return {
    name: target.name,
    provenanceKind: target.provenance?.kind ?? "synthetic-fixture",
    provenanceUrl: target.provenance?.url ?? null,
    runner: plan.recommendedRunner.name,
    runnerExpected: expect.runner ?? null,
    runnerCorrect: expect.runner ? plan.recommendedRunner.name === expect.runner : null,
    flows: plan.flows.length,
    planFlowTitles,
    flowTitles,
    successSignals,
    existingEvidencePaths,
    entrypoints,
    changeIntents: plan.changeAnalysis.intents.length,
    highConfidenceIntents: plan.changeAnalysis.intents.filter((intent) => intent.confidence === "high").length,
    intentTitles,
    intentLifecycle,
    intentScenarios,
    qaScenarios: qaScenarios.length,
    locatedQaScenarios: locatedQaScenarios.length,
    scenarioTrace: qaScenarios.length > 0 ? `${locatedQaScenarios.length}/${qaScenarios.length}` : null,
    scenarioReceipts: scenarioReceipts.length,
    scenarioReceiptCoverage: qaScenarios.length > 0 ? `${scenarioReceipts.length}/${qaScenarios.length}` : null,
    reasoningTraces: qa.traces.length,
    reasoningTraceCoverage: qaScenarios.length > 0 ? `${qa.traces.length}/${qaScenarios.length}` : null,
    traceableReasoning: qa.traces.filter((trace) => trace.status === "traceable").length,
    missingReasoningTraces: qaScenarios.filter((scenario) => !reasoningTraceIds.has(scenario.id)).length,
    untraceableRequiredScenarios: qa.traces.filter(
      (trace) => trace.scenario.decision === "required" && trace.status !== "traceable"
    ).length,
    missingScenarioReceipts: qaScenarios.filter((scenario) => !scenarioReceiptIds.has(scenario.id)).length,
    routedRequiredScenarios: scenarioReceipts.filter((receipt) => receipt.decision === "required").length,
    routedRecommendedScenarios: scenarioReceipts.filter((receipt) => receipt.decision === "recommended").length,
    routedReviewOnlyScenarios: scenarioReceipts.filter((receipt) => receipt.decision === "review-only").length,
    compiledScenarioReceipts: scenarioReceipts.filter((receipt) => receipt.status === "compiled").length,
    partialScenarioReceipts: scenarioReceipts.filter((receipt) => receipt.status === "partial").length,
    notCompiledScenarioReceipts: scenarioReceipts.filter((receipt) => receipt.status === "not-compiled").length,
    mappedScenarioSteps: scenarioReceipts.reduce((sum, receipt) => sum + receipt.mappedSteps, 0),
    mappedScenarioAssertions: scenarioReceipts.reduce((sum, receipt) => sum + receipt.mappedAssertions, 0),
    requiredScenarioGaps: scenarioReceipts.filter(
      (receipt) => receipt.decision === "required" && receipt.status !== "compiled"
    ).length,
    untracedCriticalScenarios: qaScenarios.filter((scenario) =>
      scenario.priority === "critical" &&
      !scenario.evidence.some((item) =>
        item.kind === "diff" && item.file && item.startLine !== undefined && item.relation !== "contextual"
      )
    ).length,
    scenarioSourceFiles,
    intentEvidence: plan.changeAnalysis.intents.flatMap((intent) =>
      intent.evidence.map((evidence) => evidence.value)
    ),
    draftPaths: qa.flows.map((flow) => normalizePath(flow.draftPath)),
    genericTitles: qa.flows.filter((flow) => genericTitlePattern.test(flow.title)).length,
    importPropagatedFlows: plan.flows.filter((flow) => flow.reason.includes("through imports")).length,
    diffAnchoredFlows: plan.flows.filter((flow) => (flow.selectors ?? []).some((selector) => selector.addedInDiff)).length,
    manifestMatches: plan.verificationManifestMatches.length,
    manifestFlowMatches: plan.verificationManifestMatches.filter((match) => match.kind === "flow").length,
    manifestBackedFlows: qa.flows.filter((flow) => flow.source === "manifest-backed").length,
    behaviorNodes: plan.behaviorGraph.summary.nodes,
    behaviorEdges: plan.behaviorGraph.summary.edges,
    behaviorImpactedNodes: plan.behaviorGraph.summary.impactedNodes,
    manifestBehaviorNodes: plan.behaviorGraph.nodes.filter((node) =>
      node.evidence.some((evidence) => evidence.kind === "manifest")
    ).length,
    commitBehaviorNodes: plan.behaviorGraph.nodes.filter((node) =>
      node.evidence.some((evidence) => evidence.kind === "commit")
    ).length,
    behaviorGraph: `${plan.behaviorGraph.summary.nodes}/${plan.behaviorGraph.summary.impactedNodes}`,
    behaviorKinds: Object.entries(plan.behaviorGraph.summary.byKind)
      .filter(([, count]) => count > 0)
      .map(([kind]) => kind),
    blankActions: allSteps.filter((step) => blankActionPattern.test(step)).length,
    mustReachRecall: mustReach.length > 0 ? `${reached.length}/${mustReach.length}` : null,
    mustReachMissing: mustReach.filter((file) => !flowFiles.has(file)),
    mustNameRecall: mustName.length > 0 ? `${named.length}/${mustName.length}` : null,
    mustNameMissing: mustName.filter((name) => !named.includes(name)),
    readiness: qa.readiness.automationApplicable
      ? `${qa.readiness.level} (${qa.readiness.score})`
      : `${qa.readiness.verificationStatus ?? "command-needed"} (repo)`,
    routeStatus: qa.route.status,
    routeNextAction: qa.route.nextAction,
    routeCommand: qa.route.command ?? null,
    readinessLevel: qa.readiness.level,
    readinessScore: qa.readiness.score,
    readinessBasis: qa.readiness.basis,
    automationApplicable: qa.readiness.automationApplicable,
    verificationStatus: qa.readiness.verificationStatus ?? null,
    runnableCandidates: qa.readiness.runnableCandidates,
    nearRunnableFiles: qa.readiness.nearRunnable,
    reviewOnlyFiles: qa.readiness.reviewOnly,
    tryableDrafts: qa.readiness.runnableCandidates + qa.readiness.nearRunnable,
    draftStatuses: qa.flows.map((flow) => flow.runnableStatus ?? "unknown"),
    selfCheckPass: qa.readiness.selfCheckPass,
    selfCheckWarning: qa.readiness.selfCheckWarning,
    selfCheckFail: qa.readiness.selfCheckFail,
    totalTodos: qa.readiness.totalTodos,
    totalExecutionBlockers: qa.readiness.totalExecutionBlockers,
    topBlockers: qa.readiness.topBlockers,
    agentBytes: Buffer.byteLength(formatAgentQaDraft(qa)),
    durationMs,
  };
}

function evaluateContract(expect, result, plan, qa) {
  const failures = [];
  const steps = [
    ...plan.flows.flatMap((flow) => flow.steps),
    ...qa.flows.flatMap((flow) => flow.draftSteps ?? []),
  ];
  const selectors = qa.flows.flatMap((flow) => flow.selectorHints ?? []);
  const evidence = qa.missingEvidence.map((item) => `${item.kind} ${item.title} ${item.detail}`);
  const commands = [
    ...qa.suggestedCommands,
    qa.runnerSetup.setupCommand,
    ...qa.runnerSetup.installCommands,
    ...qa.runnerSetup.nextCommands,
  ].filter(Boolean);
  const behaviorNodeIds = new Set(plan.behaviorGraph.nodes.map((node) => node.id));
  const danglingBehaviorEdges = plan.behaviorGraph.edges.filter(
    (edge) => !behaviorNodeIds.has(edge.from) || !behaviorNodeIds.has(edge.to),
  );

  if (expect.readinessBasis !== undefined && result.readinessBasis !== expect.readinessBasis) {
    failures.push(`readiness basis expected ${expect.readinessBasis}, got ${result.readinessBasis}`);
  }
  if (expect.routeStatus !== undefined && result.routeStatus !== expect.routeStatus) {
    failures.push(`route status expected ${expect.routeStatus}, got ${result.routeStatus}`);
  }
  if (expect.routeNextAction !== undefined && result.routeNextAction !== expect.routeNextAction) {
    failures.push(`route next action expected ${expect.routeNextAction}, got ${result.routeNextAction}`);
  }
  appendMissingTerms(
    failures,
    "route command",
    result.routeCommand ? [result.routeCommand] : [],
    expect.mustRouteCommands,
  );
  if (
    expect.automationApplicable !== undefined &&
    result.automationApplicable !== expect.automationApplicable
  ) {
    failures.push(
      `automation applicability expected ${expect.automationApplicable}, got ${result.automationApplicable}`,
    );
  }
  if (
    expect.verificationStatus !== undefined &&
    result.verificationStatus !== expect.verificationStatus
  ) {
    failures.push(`verification status expected ${expect.verificationStatus}, got ${result.verificationStatus}`);
  }

  if (plan.behaviorGraph.schemaVersion !== 1) {
    failures.push(`behavior graph schema expected 1, got ${plan.behaviorGraph.schemaVersion}`);
  }
  if (plan.behaviorGraph.summary.byKind.flow < plan.flows.length) {
    failures.push(
      `behavior graph expected at least ${plan.flows.length} flow node(s), got ${plan.behaviorGraph.summary.byKind.flow}`,
    );
  }
  if (plan.changedFiles.length > 0 && plan.behaviorGraph.summary.impactedNodes === 0) {
    failures.push("behavior graph has no impacted nodes for a non-empty branch diff");
  }
  if (danglingBehaviorEdges.length > 0) {
    failures.push(`behavior graph has ${danglingBehaviorEdges.length} dangling edge(s)`);
  }
  if (
    expect.minManifestBehaviorNodes !== undefined &&
    result.manifestBehaviorNodes < expect.minManifestBehaviorNodes
  ) {
    failures.push(
      `expected at least ${expect.minManifestBehaviorNodes} manifest behavior node(s), got ${result.manifestBehaviorNodes}`,
    );
  }
  appendMissingTerms(failures, "behavior kind", result.behaviorKinds, expect.mustHaveBehaviorKinds);
  if (expect.minChangeIntents !== undefined && result.changeIntents < expect.minChangeIntents) {
    failures.push(`expected at least ${expect.minChangeIntents} change intent(s), got ${result.changeIntents}`);
  }
  if (
    expect.minHighConfidenceIntents !== undefined &&
    result.highConfidenceIntents < expect.minHighConfidenceIntents
  ) {
    failures.push(
      `expected at least ${expect.minHighConfidenceIntents} high-confidence intent(s), got ${result.highConfidenceIntents}`,
    );
  }
  if (expect.minCommitBehaviorNodes !== undefined && result.commitBehaviorNodes < expect.minCommitBehaviorNodes) {
    failures.push(
      `expected at least ${expect.minCommitBehaviorNodes} commit-backed behavior node(s), got ${result.commitBehaviorNodes}`,
    );
  }
  appendMissingTerms(failures, "intent title", result.intentTitles, expect.mustNameIntents);
  appendUnexpectedTerms(failures, "intent title", result.intentTitles, expect.mustNotNameIntents);
  appendMissingTerms(failures, "intent lifecycle", result.intentLifecycle, expect.mustIncludeLifecycle);
  appendMissingTerms(failures, "intent QA scenario", result.intentScenarios, expect.mustIncludeQaScenarios);
  appendUnexpectedTerms(failures, "intent QA scenario", result.intentScenarios, expect.mustNotIncludeQaScenarios);
  appendMissingTerms(failures, "intent evidence", result.intentEvidence, expect.mustFindIntentEvidence);
  appendMissingTerms(failures, "scenario source file", result.scenarioSourceFiles, expect.mustTraceScenarioFiles);
  appendMissingTerms(failures, "existing test evidence", result.existingEvidencePaths, expect.mustFindExistingEvidence);
  if (expect.provenanceKind !== undefined && result.provenanceKind !== expect.provenanceKind) {
    failures.push(`provenance kind expected ${expect.provenanceKind}, got ${result.provenanceKind}`);
  }
  if (
    expect.maxUntracedCriticalScenarios !== undefined &&
    result.untracedCriticalScenarios > expect.maxUntracedCriticalScenarios
  ) {
    failures.push(
      `untraced critical scenarios ${result.untracedCriticalScenarios} exceed ${expect.maxUntracedCriticalScenarios}`,
    );
  }
  if (expect.minScenarioReceipts !== undefined && result.scenarioReceipts < expect.minScenarioReceipts) {
    failures.push(`expected at least ${expect.minScenarioReceipts} scenario receipt(s), got ${result.scenarioReceipts}`);
  }
  if (
    expect.maxMissingScenarioReceipts !== undefined &&
    result.missingScenarioReceipts > expect.maxMissingScenarioReceipts
  ) {
    failures.push(
      `missing scenario receipts ${result.missingScenarioReceipts} exceed ${expect.maxMissingScenarioReceipts}`,
    );
  }
  if (expect.minReasoningTraces !== undefined && result.reasoningTraces < expect.minReasoningTraces) {
    failures.push(`expected at least ${expect.minReasoningTraces} reasoning trace(s), got ${result.reasoningTraces}`);
  }
  if (
    expect.maxMissingReasoningTraces !== undefined &&
    result.missingReasoningTraces > expect.maxMissingReasoningTraces
  ) {
    failures.push(
      `missing reasoning traces ${result.missingReasoningTraces} exceed ${expect.maxMissingReasoningTraces}`,
    );
  }
  if (
    expect.maxUntraceableRequiredScenarios !== undefined &&
    result.untraceableRequiredScenarios > expect.maxUntraceableRequiredScenarios
  ) {
    failures.push(
      `untraceable required scenarios ${result.untraceableRequiredScenarios} exceed ${expect.maxUntraceableRequiredScenarios}`,
    );
  }
  if (
    expect.minRoutedRequiredScenarios !== undefined &&
    result.routedRequiredScenarios < expect.minRoutedRequiredScenarios
  ) {
    failures.push(
      `expected at least ${expect.minRoutedRequiredScenarios} required routed scenario(s), got ${result.routedRequiredScenarios}`,
    );
  }
  if (
    expect.maxRequiredScenarioGaps !== undefined &&
    result.requiredScenarioGaps > expect.maxRequiredScenarioGaps
  ) {
    failures.push(
      `required scenario gaps ${result.requiredScenarioGaps} exceed ${expect.maxRequiredScenarioGaps}`,
    );
  }
  if (
    expect.minMappedScenarioAssertions !== undefined &&
    result.mappedScenarioAssertions < expect.minMappedScenarioAssertions
  ) {
    failures.push(
      `expected at least ${expect.minMappedScenarioAssertions} mapped scenario assertion(s), got ${result.mappedScenarioAssertions}`,
    );
  }
  if (
    expect.minMappedScenarioSteps !== undefined &&
    result.mappedScenarioSteps < expect.minMappedScenarioSteps
  ) {
    failures.push(
      `expected at least ${expect.minMappedScenarioSteps} mapped scenario step(s), got ${result.mappedScenarioSteps}`,
    );
  }
  if (
    expect.maxMappedScenarioSteps !== undefined &&
    result.mappedScenarioSteps > expect.maxMappedScenarioSteps
  ) {
    failures.push(
      `mapped scenario steps ${result.mappedScenarioSteps} exceed ${expect.maxMappedScenarioSteps}`,
    );
  }

  if (expect.runner && result.runner !== expect.runner) {
    failures.push(`runner expected ${expect.runner}, got ${result.runner}`);
  }
  if (expect.minFlows !== undefined && result.flows < expect.minFlows) {
    failures.push(`expected at least ${expect.minFlows} flow(s), got ${result.flows}`);
  }
  if (
    expect.minImportPropagatedFlows !== undefined &&
    result.importPropagatedFlows < expect.minImportPropagatedFlows
  ) {
    failures.push(
      `expected at least ${expect.minImportPropagatedFlows} import-propagated flow(s), got ${result.importPropagatedFlows}`,
    );
  }
  if (expect.minDiffAnchoredFlows !== undefined && result.diffAnchoredFlows < expect.minDiffAnchoredFlows) {
    failures.push(`expected at least ${expect.minDiffAnchoredFlows} diff-anchored flow(s), got ${result.diffAnchoredFlows}`);
  }
  if (expect.minManifestMatches !== undefined && result.manifestMatches < expect.minManifestMatches) {
    failures.push(`expected at least ${expect.minManifestMatches} manifest match(es), got ${result.manifestMatches}`);
  }
  if (expect.minManifestFlowMatches !== undefined && result.manifestFlowMatches < expect.minManifestFlowMatches) {
    failures.push(`expected at least ${expect.minManifestFlowMatches} manifest flow match(es), got ${result.manifestFlowMatches}`);
  }
  if (expect.minManifestBackedFlows !== undefined && result.manifestBackedFlows < expect.minManifestBackedFlows) {
    failures.push(`expected at least ${expect.minManifestBackedFlows} manifest-backed flow(s), got ${result.manifestBackedFlows}`);
  }
  appendMissingTerms(failures, "flow title", result.flowTitles, expect.mustNameFlows);
  appendUnexpectedTerms(failures, "flow title", result.flowTitles, expect.mustNotNameFlows);
  appendMissingTerms(failures, "draft path", result.draftPaths, expect.mustDraftFiles);
  appendMissingTerms(failures, "step", steps, expect.mustIncludeSteps);
  appendMissingTerms(failures, "selector", selectors, expect.mustFindSelectors);
  appendMissingTerms(failures, "success signal", result.successSignals, expect.mustFindSuccessSignals);
  appendMissingTerms(failures, "entrypoint", result.entrypoints, expect.mustFindEntrypoints);
  appendMissingTerms(failures, "evidence", evidence, expect.mustFindEvidence);
  appendUnexpectedTerms(failures, "evidence", evidence, expect.mustNotFindEvidence);
  appendMissingTerms(failures, "command", commands, expect.mustRecommendCommands);

  if (result.mustReachMissing.length > 0) {
    failures.push(`changed flow did not reach: ${result.mustReachMissing.join(", ")}`);
  }
  if (expect.maxBlankActions !== undefined && result.blankActions > expect.maxBlankActions) {
    failures.push(`blank actions ${result.blankActions} exceed ${expect.maxBlankActions}`);
  }
  if (expect.maxGenericTitles !== undefined && result.genericTitles > expect.maxGenericTitles) {
    failures.push(`generic titles ${result.genericTitles} exceed ${expect.maxGenericTitles}`);
  }
  if (expect.maxAgentBytes !== undefined && result.agentBytes > expect.maxAgentBytes) {
    failures.push(`agent payload ${result.agentBytes} bytes exceeds ${expect.maxAgentBytes}`);
  }
  if (expect.minReadinessScore !== undefined && result.readinessScore < expect.minReadinessScore) {
    failures.push(`readiness score ${result.readinessScore} is below ${expect.minReadinessScore}`);
  }
  if (
    Array.isArray(expect.allowedReadinessLevels) &&
    !expect.allowedReadinessLevels.includes(result.readinessLevel)
  ) {
    failures.push(
      `readiness level ${result.readinessLevel} is not one of ${expect.allowedReadinessLevels.join(", ")}`,
    );
  }
  if (expect.minTryableDrafts !== undefined && result.tryableDrafts < expect.minTryableDrafts) {
    failures.push(`expected at least ${expect.minTryableDrafts} tryable draft(s), got ${result.tryableDrafts}`);
  }
  if (
    expect.minRunnableCandidates !== undefined &&
    result.runnableCandidates < expect.minRunnableCandidates
  ) {
    failures.push(
      `expected at least ${expect.minRunnableCandidates} runnable candidate(s), got ${result.runnableCandidates}`,
    );
  }
  if (expect.minSelfCheckPass !== undefined && result.selfCheckPass < expect.minSelfCheckPass) {
    failures.push(`expected at least ${expect.minSelfCheckPass} passing draft self-check(s), got ${result.selfCheckPass}`);
  }
  if (expect.maxSelfCheckFail !== undefined && result.selfCheckFail > expect.maxSelfCheckFail) {
    failures.push(`failed draft self-checks ${result.selfCheckFail} exceed ${expect.maxSelfCheckFail}`);
  }
  if (expect.maxReviewOnlyFiles !== undefined && result.reviewOnlyFiles > expect.maxReviewOnlyFiles) {
    failures.push(`review-only drafts ${result.reviewOnlyFiles} exceed ${expect.maxReviewOnlyFiles}`);
  }
  if (expect.maxTodos !== undefined && result.totalTodos > expect.maxTodos) {
    failures.push(`draft TODO markers ${result.totalTodos} exceed ${expect.maxTodos}`);
  }
  if (
    expect.maxExecutionBlockers !== undefined &&
    result.totalExecutionBlockers > expect.maxExecutionBlockers
  ) {
    const topBlocker = result.topBlockers[0] ? ` Top blocker: ${result.topBlockers[0]}` : "";
    failures.push(
      `draft execution blockers ${result.totalExecutionBlockers} exceed ${expect.maxExecutionBlockers}.${topBlocker}`,
    );
  }
  return failures;
}

function appendMissingTerms(failures, label, actualValues, expectedTerms = []) {
  for (const term of expectedTerms) {
    if (!includesTerm(actualValues, term)) {
      failures.push(`${label} missing "${term}"`);
    }
  }
}

function appendUnexpectedTerms(failures, label, actualValues, rejectedTerms = []) {
  for (const term of rejectedTerms) {
    if (includesTerm(actualValues, term)) {
      failures.push(`${label} unexpectedly contains "${term}"`);
    }
  }
}

function includesTerm(values, term) {
  const expected = String(term).toLowerCase();
  return values.some((value) => String(value).toLowerCase().includes(expected));
}

async function prepareTarget(target, configDir) {
  await validateTargetProvenance(target, configDir);
  if (target.fixture) {
    return materializeFixture(target, configDir);
  }
  if (!target.path) {
    throw new Error(`Target ${target.name} must define either path or fixture.`);
  }
  const repositoryRoot = path.resolve(expandHome(target.path));
  return targetPaths(target, repositoryRoot, target.base, target.head);
}

async function validateTargetProvenance(target, configDir) {
  const provenance = target.provenance;
  if (!provenance) return;
  if (provenance.kind !== "public-pull-request") {
    throw new Error(`Target ${target.name} has unsupported provenance kind ${provenance.kind}.`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(provenance.repository ?? "")) {
    throw new Error(`Target ${target.name} must pin a public owner/repository.`);
  }
  if (!Number.isInteger(provenance.pullRequest) || provenance.pullRequest <= 0) {
    throw new Error(`Target ${target.name} must pin a positive pull request number.`);
  }
  const expectedUrl = `https://github.com/${provenance.repository}/pull/${provenance.pullRequest}`;
  if (provenance.url !== expectedUrl) {
    throw new Error(`Target ${target.name} provenance URL must be ${expectedUrl}.`);
  }
  for (const refName of ["base", "head"]) {
    if (!/^[0-9a-f]{40}$/.test(provenance[refName] ?? "")) {
      throw new Error(`Target ${target.name} must pin a 40-character ${refName} commit.`);
    }
  }
  if (typeof provenance.license !== "string" || provenance.license.trim().length === 0) {
    throw new Error(`Target ${target.name} must record the source license.`);
  }
  if (!target.fixture) return;
  const provenancePath = path.resolve(configDir, target.fixture, "PROVENANCE.md");
  const provenanceText = await fs.readFile(provenancePath, "utf8");
  for (const pinnedValue of [
    provenance.url,
    provenance.base,
    provenance.head,
    provenance.license,
  ]) {
    if (!provenanceText.includes(pinnedValue)) {
      throw new Error(`Target ${target.name} PROVENANCE.md does not include ${pinnedValue}.`);
    }
  }
}

async function materializeFixture(target, configDir) {
  const fixtureRoot = path.resolve(configDir, target.fixture);
  const baseRoot = path.join(fixtureRoot, "base");
  const headRoot = path.join(fixtureRoot, "head");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-bench-"));
  const repositoryRoot = path.join(tempRoot, "repo");
  await fs.mkdir(repositoryRoot, { recursive: true });
  await fs.cp(baseRoot, repositoryRoot, { recursive: true });
  await git(repositoryRoot, ["init", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.email", "benchmark@qamap.local"]);
  await git(repositoryRoot, ["config", "user.name", "QAMap Benchmark"]);
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "benchmark baseline"]);
  let manifestPath;
  if (target.manifestBaseline) {
    manifestPath = path.join(tempRoot, "manifest.yaml");
    await writeVerificationManifestBaseline(repositoryRoot, {
      write: manifestPath,
      force: true,
    });
  }
  await git(repositoryRoot, ["switch", "-c", "benchmark/change"]);
  if (await exists(headRoot)) {
    await fs.cp(headRoot, repositoryRoot, { recursive: true, force: true });
  }
  await git(repositoryRoot, ["add", "-A"]);
  await git(repositoryRoot, ["commit", "--allow-empty", "-m", target.commitMessage ?? "benchmark change"]);
  const prepared = targetPaths(target, repositoryRoot, "main", "HEAD");
  return {
    ...prepared,
    manifestPath,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
  };
}

function targetPaths(target, repositoryRoot, base, head) {
  const root = target.targetPath ? path.join(repositoryRoot, target.targetPath) : repositoryRoot;
  const workspaceRoot = target.workspaceRoot ? path.join(repositoryRoot, target.workspaceRoot) : undefined;
  return { root, workspaceRoot, base, head };
}

async function git(cwd, gitArgs) {
  await execFileAsync("git", gitArgs, { cwd });
}

async function defaultConfigPath() {
  for (const candidate of ["bench.config.local.json", "bench.config.json"]) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error("No benchmark config found. Create bench.config.local.json or use --config <file>.");
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function printTable(rows) {
  const columns = [
    ["name", 24],
    ["contractPassed", 8],
    ["runner", 11],
    ["flows", 5],
    ["importPropagatedFlows", 10],
    ["diffAnchoredFlows", 10],
    ["manifestFlowMatches", 8],
    ["behaviorGraph", 9],
    ["changeIntents", 7],
    ["scenarioTrace", 8],
    ["reasoningTraceCoverage", 8],
    ["scenarioReceiptCoverage", 8],
    ["scenarioAutomation", 9],
    ["blankActions", 6],
    ["genericTitles", 8],
    ["mustReachRecall", 10],
    ["readiness", 18],
    ["draftReadiness", 11],
    ["totalExecutionBlockers", 8],
    ["agentBytes", 10],
    ["durationMs", 10],
  ];
  const header = columns.map(([key, width]) => shortLabel(key).padEnd(width)).join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    if (row.error) {
      console.log(`${row.name.padEnd(24)} ERROR: ${row.error}`);
    } else {
      console.log(columns.map(([key, width]) => String(displayValue(row, key)).padEnd(width)).join(" "));
    }
    for (const failure of row.contractFailures ?? []) {
      console.log(`  ! ${failure}`);
    }
  }
}

function displayValue(row, key) {
  if (key === "contractPassed") {
    return row.contractPassed ? "PASS" : "FAIL";
  }
  if (key === "draftReadiness") {
    return `${row.runnableCandidates ?? 0}/${row.nearRunnableFiles ?? 0}/${row.reviewOnlyFiles ?? 0}`;
  }
  if (key === "scenarioAutomation") {
    return `${row.compiledScenarioReceipts ?? 0}/${row.partialScenarioReceipts ?? 0}/${row.notCompiledScenarioReceipts ?? 0}`;
  }
  return row[key] ?? "-";
}

function printDeltas(baselineRows, currentRows) {
  console.log("\nDelta vs baseline (negative blankActions/genericTitles is better):");
  for (const current of currentRows) {
    const before = baselineRows.find((row) => row.name === current.name);
    if (!before || current.error || before.error) {
      continue;
    }
    const deltas = [];
    for (const key of ["flows", "changeIntents", "highConfidenceIntents", "importPropagatedFlows", "diffAnchoredFlows", "manifestFlowMatches", "behaviorNodes", "behaviorImpactedNodes", "manifestBehaviorNodes", "commitBehaviorNodes", "reasoningTraces", "traceableReasoning", "missingReasoningTraces", "untraceableRequiredScenarios", "scenarioReceipts", "missingScenarioReceipts", "compiledScenarioReceipts", "partialScenarioReceipts", "notCompiledScenarioReceipts", "mappedScenarioSteps", "mappedScenarioAssertions", "requiredScenarioGaps", "blankActions", "genericTitles", "readinessScore", "tryableDrafts", "totalTodos", "totalExecutionBlockers", "agentBytes"]) {
      const diff = (current[key] ?? 0) - (before[key] ?? 0);
      if (diff !== 0) {
        deltas.push(`${key} ${diff > 0 ? "+" : ""}${diff}`);
      }
    }
    console.log(`- ${current.name}: ${deltas.length > 0 ? deltas.join(", ") : "no change"}`);
  }
}

function shortLabel(key) {
  const labels = {
    contractPassed: "contract",
    importPropagatedFlows: "viaImport",
    diffAnchoredFlows: "diffAnchor",
    manifestFlowMatches: "manifest",
    behaviorGraph: "graph n/i",
    changeIntents: "intents",
    scenarioTrace: "trace",
    reasoningTraceCoverage: "path",
    scenarioReceiptCoverage: "receipt",
    scenarioAutomation: "map c/p/n",
    blankActions: "blank",
    genericTitles: "generic",
    mustReachRecall: "reach",
    draftReadiness: "draft r/n/o",
    totalExecutionBlockers: "blockers",
    durationMs: "ms",
  };
  return labels[key] ?? key;
}

function readArg(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function expandHome(value) {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function normalizePath(value) {
  return String(value).replaceAll(path.sep, "/").replace(/^\.\//, "");
}

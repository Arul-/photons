/**
 * External tests for integration-demo.photon.ts
 *
 * Run with: photon test integration-demo
 */

export async function testVersionInfo(photon: any): Promise<{ passed: boolean; message: string }> {
  const result = await photon.info();

  if (result.photonName !== 'integration-demo') {
    return { passed: false, message: `Expected photonName=integration-demo, got ${result.photonName}` };
  }
  if (result.photonVersion !== '1.0.0') {
    return { passed: false, message: `Expected version=1.0.0, got ${result.photonVersion}` };
  }
  if (result.runtimeConstraint !== '>=1.0.0') {
    return { passed: false, message: `Expected constraint >=1.0.0, got ${result.runtimeConstraint}` };
  }
  if (!result.platform) {
    return { passed: false, message: 'Missing platform info' };
  }
  if (!result.nodeVersion.startsWith('v')) {
    return { passed: false, message: `Node version should start with v, got ${result.nodeVersion}` };
  }
  if (!Array.isArray(result.cliDependencies) || result.cliDependencies.length === 0) {
    return { passed: false, message: 'Should have cli dependencies listed' };
  }
  if (!Array.isArray(result.annotations) || result.annotations.length === 0) {
    return { passed: false, message: 'Should have annotations listed' };
  }

  return { passed: true, message: 'Info returns complete structure with version, platform, and dependencies' };
}

export async function testWorkflowSteps(photon: any): Promise<{ passed: boolean; message: string }> {
  const gen = photon.workflow({ input: 'test-data', steps: 3 });
  const yields: any[] = [];

  let result = await gen.next();
  while (!result.done) {
    yields.push(result.value);
    result = await gen.next();
  }

  // Check we got checkpoints
  const checkpoints = yields.filter(y => y && y.checkpoint === true);
  if (checkpoints.length !== 3) {
    return { passed: false, message: `Expected 3 checkpoints, got ${checkpoints.length}` };
  }

  // Check we got progress emissions
  const progress = yields.filter(y => y && y.emit === 'progress');
  if (progress.length < 3) {
    return { passed: false, message: `Expected at least 3 progress yields, got ${progress.length}` };
  }

  // Check final return value
  const finalValue = result.value;
  if (!finalValue.steps || finalValue.steps.length !== 3) {
    return { passed: false, message: `Expected 3 completed steps, got ${finalValue.steps?.length}` };
  }
  if (!finalValue.finalResult.includes('test-data')) {
    return { passed: false, message: 'Final result should contain input data' };
  }

  // Check each step is marked complete
  for (const step of finalValue.steps) {
    if (step.status !== 'complete') {
      return { passed: false, message: `Step "${step.name}" should be complete, got ${step.status}` };
    }
  }

  return { passed: true, message: 'Workflow yields 3 checkpoints, progress updates, and returns completed steps' };
}

export async function testAssetDiscovery(photon: any): Promise<{ passed: boolean; message: string }> {
  const result = await photon.assets();

  if (result.assetFolder !== 'integration-demo/') {
    return { passed: false, message: `Expected folder integration-demo/, got ${result.assetFolder}` };
  }
  if (!result.uiAssets.includes('ui/result-viewer.html')) {
    return { passed: false, message: 'Should include ui/result-viewer.html in assets' };
  }
  if (result.annotations.length === 0) {
    return { passed: false, message: 'Should have ui annotations' };
  }

  return { passed: true, message: 'Asset discovery returns correct folder structure and UI assets' };
}

export async function testResourceMethod(photon: any): Promise<{ passed: boolean; message: string }> {
  const result = await photon.status();

  if (result.name !== 'integration-demo') {
    return { passed: false, message: `Expected name=integration-demo, got ${result.name}` };
  }
  if (typeof result.uptime !== 'number') {
    return { passed: false, message: 'uptime should be a number' };
  }
  if (!Array.isArray(result.features) || result.features.length < 4) {
    return { passed: false, message: `Expected at least 4 features, got ${result.features?.length}` };
  }

  return { passed: true, message: 'Resource method returns structured status with features list' };
}

export async function testMarkdownReport(photon: any): Promise<{ passed: boolean; message: string }> {
  const result = await photon.report();

  if (!result.includes('# Integration Demo Report')) {
    return { passed: false, message: 'Report should have markdown heading' };
  }
  if (!result.includes('Platform')) {
    return { passed: false, message: 'Report should include platform info' };
  }
  if (!result.includes('Stateful workflows')) {
    return { passed: false, message: 'Report should mention stateful workflows' };
  }

  return { passed: true, message: 'Markdown report contains heading, platform, and feature list' };
}

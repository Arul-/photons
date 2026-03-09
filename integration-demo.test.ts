export async function testVersionInfo(photon: any) {
  const result = await photon.info();

  if (result.photonName !== 'integration-demo') {
    throw new Error(`Expected photonName=integration-demo, got ${result.photonName}`);
  }
  if (result.photonVersion !== '1.0.0') {
    throw new Error(`Expected version=1.0.0, got ${result.photonVersion}`);
  }
  if (result.runtimeConstraint !== '>=1.0.0') {
    throw new Error(`Expected constraint >=1.0.0, got ${result.runtimeConstraint}`);
  }
  if (!result.platform) {
    throw new Error('Missing platform info');
  }
  if (!result.nodeVersion.startsWith('v')) {
    throw new Error(`Node version should start with v, got ${result.nodeVersion}`);
  }
  if (!Array.isArray(result.cliDependencies) || result.cliDependencies.length === 0) {
    throw new Error('Should have cli dependencies listed');
  }
  if (!Array.isArray(result.annotations) || result.annotations.length === 0) {
    throw new Error('Should have annotations listed');
  }
}

export async function testWorkflowSteps(photon: any) {
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
    throw new Error(`Expected 3 checkpoints, got ${checkpoints.length}`);
  }

  // Check we got progress emissions
  const progress = yields.filter(y => y && y.emit === 'progress');
  if (progress.length < 3) {
    throw new Error(`Expected at least 3 progress yields, got ${progress.length}`);
  }

  // Check final return value
  const finalValue = result.value;
  if (!finalValue.steps || finalValue.steps.length !== 3) {
    throw new Error(`Expected 3 completed steps, got ${finalValue.steps?.length}`);
  }
  if (!finalValue.finalResult.includes('test-data')) {
    throw new Error('Final result should contain input data');
  }

  // Check each step is marked complete
  for (const step of finalValue.steps) {
    if (step.status !== 'complete') {
      throw new Error(`Step "${step.name}" should be complete, got ${step.status}`);
    }
  }
}

export async function testAssetDiscovery(photon: any) {
  const result = await photon.assets();

  if (result.assetFolder !== 'integration-demo/') {
    throw new Error(`Expected folder integration-demo/, got ${result.assetFolder}`);
  }
  if (!result.uiAssets.includes('ui/result-viewer.html')) {
    throw new Error('Should include ui/result-viewer.html in assets');
  }
  if (result.annotations.length === 0) {
    throw new Error('Should have ui annotations');
  }
}

export async function testResourceMethod(photon: any) {
  const result = await photon.status();

  if (result.name !== 'integration-demo') {
    throw new Error(`Expected name=integration-demo, got ${result.name}`);
  }
  if (typeof result.uptime !== 'number') {
    throw new Error('uptime should be a number');
  }
  if (!Array.isArray(result.features) || result.features.length < 4) {
    throw new Error(`Expected at least 4 features, got ${result.features?.length}`);
  }
}

export async function testMarkdownReport(photon: any) {
  const result = await photon.report();

  if (!result.includes('# Integration Demo Report')) {
    throw new Error('Report should have markdown heading');
  }
  if (!result.includes('Platform')) {
    throw new Error('Report should include platform info');
  }
  if (!result.includes('Stateful workflows')) {
    throw new Error('Report should mention stateful workflows');
  }
}

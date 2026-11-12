// aio app hook (pre-app-deploy, pre-app-run): refuses to deploy when the
// action inputs that app.config.yaml reads from the environment are missing.
// A deploy from a machine whose .env lacks them would otherwise replace the
// workspace's actions with empty configuration (no Merchant Center account,
// PRICE_SYNC_MODE off, no editors). CI sets them in the deploy step's env.

const REQUIRED = ['GMC_ENV', 'GMC_MERCHANT_ACCOUNT_ID', 'GMC_DATASOURCE_ID', 'GMC_SERVICE_ACCOUNT_JSON', 'PRICE_SYNC_MODE']

function missingInputs (env = process.env) {
  return REQUIRED.filter(k => !String(env[k] || '').trim())
}

module.exports = async function checkDeployInputs () {
  const missing = missingInputs()
  if (missing.length) {
    throw new Error(`refusing to deploy: ${missing.join(', ')} not set. Deploy through GitHub (push to main for stage, a release for prod), or put every input listed in .env.example in .env.`)
  }
}
module.exports.missingInputs = missingInputs

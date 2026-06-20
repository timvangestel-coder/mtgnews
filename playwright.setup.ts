import 'dotenv/config';

async function globalSetup() {
  // Disable LLM logging during tests
  process.env.DISABLE_LLM_LOGGING = 'true';
}

export default globalSetup;

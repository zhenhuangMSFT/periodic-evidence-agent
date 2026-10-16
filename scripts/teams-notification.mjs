import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJson, requireThat, safeError } from '../src/common.js';
import { sendTeamsNotification, teamsNotificationReceiptPath } from '../src/teams-notifications.js';

const usage = 'npm run notify:teams -- --message MESSAGE_JSON [--config teams.local.json] [--receipt RECEIPT_JSON]';

try {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      message: { type: 'string' },
      receipt: { type: 'string' },
      help: { type: 'boolean' }
    },
    allowPositionals: false
  });
  if (values.help) {
    console.log(usage);
  } else {
    const configPath = values.config ?? fileURLToPath(new URL('../teams.local.json', import.meta.url));
    requireThat(configPath.endsWith('.local.json') && values.message, `Usage: ${usage}`);
    const config = readJson(configPath);
    const notification = readJson(values.message);
    const receiptPath = values.receipt ?? teamsNotificationReceiptPath(configPath, config, notification.id);
    const receipt = await sendTeamsNotification(config, notification, receiptPath);
    console.log(JSON.stringify(receipt, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify(safeError(error)));
  process.exitCode = 1;
}

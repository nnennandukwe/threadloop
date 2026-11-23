// Independent process controls for the harness. The controller bundle excludes this file.
import fs from 'node:fs';

const [operation, ...values] = process.argv.slice(2);
if (operation === 'read') {
  const denied = values.map((file) => {
    try {
      const descriptor = fs.openSync(file, 'r');
      fs.closeSync(descriptor);
      return 'readable';
    } catch (error) {
      return error.code;
    }
  });
  process.stdout.write(JSON.stringify(denied));
} else if (operation === 'timeout') {
  fs.writeFileSync('started', 'timeout control');
  setInterval(() => {}, 60_000);
} else if (operation === 'reply') {
  fs.readFileSync(0);
  process.stdout.write(values[0]);
} else {
  throw new Error('Unknown independent harness control');
}

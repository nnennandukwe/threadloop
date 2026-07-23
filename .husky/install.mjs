if (process.env.CI === 'true' || process.env.NODE_ENV === 'production') {
  process.exit(0);
}

const husky = (await import('husky')).default;
const result = husky();

if (result) {
  console.error(result);
  process.exitCode = 1;
}

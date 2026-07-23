import { validateCommunityRepository } from './community-template-validator.js';

const errors = await validateCommunityRepository(process.cwd());

if (errors.length > 0) {
  console.error('Community file validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log('Community file validation passed.');
}

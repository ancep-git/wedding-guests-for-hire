export class DuplicateRefError extends Error {
  constructor(ref) {
    super(`Reference ${ref} already exists. Use a new, unique reference.`);
    this.code = 'duplicate';
  }
}

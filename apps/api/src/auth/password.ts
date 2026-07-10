import { argon2id, hash, needsRehash, verify } from "argon2";

export const passwordHashOptions = {
  memoryCost: 19_456,
  parallelism: 1,
  timeCost: 2,
  type: argon2id
} as const;

const dummyPasswordHash = hash("HahaTalk dummy password material", passwordHashOptions);

export function hashPassword(password: string) {
  return hash(password, passwordHashOptions);
}

export async function verifyPassword(passwordHash: string | null | undefined, password: string) {
  const candidateHash = passwordHash ?? await dummyPasswordHash;
  const matches = await verify(candidateHash, password).catch(() => false);
  return { candidateHash, matches };
}

export function passwordNeedsRehash(passwordHash: string) {
  return needsRehash(passwordHash, passwordHashOptions);
}

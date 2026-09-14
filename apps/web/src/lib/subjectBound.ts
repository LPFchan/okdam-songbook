/**
 * Await work started for one account, but only expose its result while that
 * immutable Auth subject is still active.
 */
export async function whileSubjectCurrent<T>(
  ownerSubject: string,
  currentSubject: () => string | undefined,
  work: () => Promise<T>
): Promise<T | undefined> {
  const result = await work();
  return currentSubject() === ownerSubject ? result : undefined;
}

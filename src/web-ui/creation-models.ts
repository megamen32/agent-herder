/** ZCode exposes unqualified model aliases alongside required reasoning
 * variants. Offer the complete native selections at the alias's position. */
export function creationModels(harness: string, models: string[]): string[] {
  if (harness !== "zcode") return models;
  const selections = models.flatMap(model => {
    const variants = models.filter(candidate => candidate.startsWith(`${model}$`));
    return variants.length ? variants : [model];
  });
  return [...new Set(selections)];
}

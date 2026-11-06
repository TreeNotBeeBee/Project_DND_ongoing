/** Accept source records supplied by the caller; never import a catalog here. */
export function equipmentPackageOptions(record: Record<string, any> | undefined, source: 'class' | 'background'): { description: string; values: any[] } {
  const choices = source === 'class' ? record?.starting_equipment_options : record?.equipment_options;
  if (!Array.isArray(choices?.[0]?.from?.options)) return { description: '', values: [] };
  const values = structuredClone(choices[0].from.options);
  // Same official Bard option A correction used by the server's grant pipeline.
  if (source === 'class' && record?.index === 'bard' && values[0]?.items && !values[0].items.some((item: any) => item.choice?.from?.equipment_category?.index === 'musical-instruments')) values[0].items.push({ option_type: 'choice', choice: { choose: 1, from: { option_set_type: 'equipment_category', equipment_category: { index: 'musical-instruments' } } } });
  return { description: String(choices[0].desc || ''), values };
}

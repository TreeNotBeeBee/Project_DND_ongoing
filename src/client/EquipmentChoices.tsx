import { useEffect } from 'react';
import type { ContentEntry } from '../shared/model';
import { equipmentPackageOptions } from '../shared/starting-equipment-options';
import { contentById, entryLabel, Field } from './components';

export interface StartingEquipmentChoice { classOption: string; backgroundOption: string; selections: Record<string, string> }
function describe(option: any, entries: ContentEntry[]): string {
  if (!option) return '';
  if (option.option_type === 'money') return `${option.count} ${String(option.unit).toUpperCase()}`;
  if (option.option_type === 'multiple') return option.items.map((value: any) => describe(value, entries)).join(' · ');
  const reference = option.of || option.item;
  if (reference) return `${option.count > 1 ? option.count + ' × ' : ''}${entryLabel(contentById(entries, reference.index), reference.name || reference.index)}`;
  if (option.option_type === 'choice') return `自选：${option.choice.desc || option.choice.from?.equipment_category?.name || '装备'}`;
  return option.desc || '';
}
export function EquipmentChoices({ classEntry, backgroundEntry, entries, value, onChange, disabled = false }: { classEntry?: ContentEntry; backgroundEntry?: ContentEntry; entries: ContentEntry[]; value: StartingEquipmentChoice; onChange: (value: StartingEquipmentChoice) => void; disabled?: boolean }) {
  const classOptions = equipmentPackageOptions(classEntry?.data, 'class').values;
  const backgroundOptions = equipmentPackageOptions(backgroundEntry?.data, 'background').values;
  useEffect(() => { if (classOptions.length && value.classOption.charCodeAt(0) - 65 >= classOptions.length || backgroundOptions.length && value.backgroundOption.charCodeAt(0) - 65 >= backgroundOptions.length) onChange({ ...value, classOption: 'A', backgroundOption: 'A', selections: {} }); }, [classEntry?.id, backgroundEntry?.id]);
  function categoryItems(id: string) {
    const category = entries.find(entry => entry.category === 'equipment-category' && entry.id.split(':').pop() === id);
    const ids = new Set((category?.data.equipment || []).map((row: any) => row.index));
    return entries.filter(entry => entry.category === 'equipment' && (ids.has(entry.id.split(':').pop()) || entry.data.equipment_categories?.some((row: any) => row.index === id))).sort((a, b) => a.name.localeCompare(b.name));
  }
  function subChoices(option: any, path: string): { path: string; label: string; candidates: ContentEntry[] }[] {
    if (option?.option_type === 'multiple') return option.items.flatMap((child: any, index: number) => subChoices(child, `${path}.${index}`));
    const reference = option?.of || option?.item;
    if (reference && !entries.some(entry => entry.category === 'equipment' && entry.id.split(':').pop() === reference.index)) return [{ path, label: reference.name || '装备类别', candidates: categoryItems(reference.index) }];
    if (option?.option_type === 'choice') {
      const choice = option.choice; let candidates: ContentEntry[] = [];
      if (choice.from?.equipment_category) candidates = categoryItems(choice.from.equipment_category.index);
      else candidates = (choice.from?.options || []).flatMap((child: any) => child.choice?.from?.equipment_category ? categoryItems(child.choice.from.equipment_category.index) : child.item ? [contentById(entries, child.item.index, 'equipment')].filter(Boolean) : []);
      return [{ path, label: choice.desc || '包内自选装备', candidates: [...new Map(candidates.map(entry => [entry.id, entry])).values()].sort((a, b) => a.name.localeCompare(b.name)) }];
    }
    return [];
  }
  const render = (options: any[], field: 'classOption' | 'backgroundOption', label: string) => {
    if (!options.length) return null;
    const index = value[field].charCodeAt(0) - 65; const selected = options[index] || options[0];
    const choices = subChoices(selected, `${field === 'classOption' ? 'class' : 'background'}:${index}`);
    return <div className="starting-equipment-group"><Field label={label}><select disabled={disabled} value={value[field]} onChange={event => onChange({ ...value, [field]: event.target.value })}>{options.map((option, index) => <option value={String.fromCharCode(65 + index)} key={index}>方案 {String.fromCharCode(65 + index)} · {describe(option, entries)}</option>)}</select></Field><p>{describe(selected, entries)}</p>{choices.map(row => <Field key={row.path} label={`自选 · ${row.label}`}><select disabled={disabled} value={value.selections[row.path] || row.candidates[0]?.id || ''} onChange={event => onChange({ ...value, selections: { ...value.selections, [row.path]: event.target.value } })}>{row.candidates.map(entry => <option key={entry.id} value={entry.id}>{entryLabel(entry)}</option>)}</select></Field>)}</div>;
  };
  return <section className="starting-equipment"><h3>职业与背景的起始装备</h3><p className="muted">首次启用时，服务器按规则授予所选装备包和金币；重复保存不会再次发放。</p>{render(classOptions, 'classOption', '职业起始方案')}{render(backgroundOptions, 'backgroundOption', '背景起始方案')}</section>;
}

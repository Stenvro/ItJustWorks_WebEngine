// A skill's perk tree (AVIF, UESP "Skyrim Mod:Mod File Format/AVIF"): after the skill's own
// fields (AVSK: its use mult, use offset, improve mult, improve offset), one group per node:
// PNAM the perk (0: the tree's root, which has none), FNAM flags, XNAM / YNAM its column and row
// in the tree's grid, HNAM / VNAM (float) how far off that grid point it lies, SNAM the skill,
// CNAM (repeated) the nodes it leads to (by INAM), INAM the node's own index. The skills menu
// draws a node as a star at its grid point plus its offset, lines to the nodes it leads to.
// Platform-independent. Notes: docs/formats/esm.md ("Perk trees").

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';

export interface PerkTreeNode {
  /** INAM: the node's index (CNAM names nodes by it). */
  readonly index: number;
  /** PNAM: the perk (undefined for the root). */
  readonly perk: number | undefined;
  readonly flags: number;
  /** XNAM, YNAM: its grid column and row. */
  readonly column: number;
  readonly row: number;
  /** HNAM, VNAM: its offset from that grid point (grid units). */
  readonly offsetX: number;
  readonly offsetY: number;
  /** SNAM: the skill (an AVIF). */
  readonly skill: number | undefined;
  /** CNAM: the nodes it leads to, by index. */
  readonly children: readonly number[];
}

export interface SkillRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  /** AVSK: skill use mult and offset, improve mult and offset (UESP, "Skills"). */
  readonly use?: {
    readonly useMult: number;
    readonly useOffset: number;
    readonly improveMult: number;
    readonly improveOffset: number;
  };
  readonly nodes: readonly PerkTreeNode[];
}

type Source = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'text' | 'formIdAt'>;

export function parseSkill(record: Source): SkillRecord {
  const nodes: PerkTreeNode[] = [];
  let node:
    | {
        perk: number | undefined;
        flags: number;
        column: number;
        row: number;
        offsetX: number;
        offsetY: number;
        skill: number | undefined;
        children: number[];
      }
    | undefined;
  let use: SkillRecord['use'];
  const u32 = (data: Uint8Array): number => (data.length >= 4 ? view(data).getUint32(0, true) : 0);
  const f32 = (data: Uint8Array): number => (data.length >= 4 ? view(data).getFloat32(0, true) : 0);
  for (const { type, data } of record.fields.list) {
    switch (type) {
      case 'AVSK':
        if (data.length >= 16) {
          use = {
            useMult: view(data).getFloat32(0, true),
            useOffset: view(data).getFloat32(4, true),
            improveMult: view(data).getFloat32(8, true),
            improveOffset: view(data).getFloat32(12, true),
          };
        }
        break;
      case 'PNAM': {
        const perk = data.length >= 4 ? record.formIdAt(data) : 0;
        node = {
          perk: perk === 0 ? undefined : perk,
          flags: 0,
          column: 0,
          row: 0,
          offsetX: 0,
          offsetY: 0,
          skill: undefined,
          children: [],
        };
        break;
      }
      case 'FNAM':
        if (node) node.flags = u32(data);
        break;
      case 'XNAM':
        if (node) node.column = u32(data);
        break;
      case 'YNAM':
        if (node) node.row = u32(data);
        break;
      case 'HNAM':
        if (node) node.offsetX = f32(data);
        break;
      case 'VNAM':
        if (node) node.offsetY = f32(data);
        break;
      case 'SNAM':
        if (node) node.skill = data.length >= 4 ? record.formIdAt(data) : undefined;
        break;
      case 'CNAM':
        // Before the first node, CNAM is the skill's category.
        if (node) node.children.push(u32(data));
        break;
      case 'INAM':
        if (node) {
          nodes.push({ index: u32(data), ...node });
          node = undefined;
        }
        break;
      default:
        break;
    }
  }
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: record.text('FULL') ?? '',
    ...(use && { use }),
    nodes,
  };
}

/** A tree's node by its index. */
export function treeNode(skill: SkillRecord, index: number): PerkTreeNode | undefined {
  return skill.nodes.find((node) => node.index === index);
}

/** The nodes that lead to a node (its parents in the tree). */
export function parentsOf(skill: SkillRecord, index: number): PerkTreeNode[] {
  return skill.nodes.filter((node) => node.children.includes(index));
}

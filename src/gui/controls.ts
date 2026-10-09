import type { SapGuiSession } from './session';
import type { SapLocator } from './locator';
import type { SapGuiValue } from './types';

/**
 * Typed helpers for the SAP controls a recording turns into long runs of
 * method calls: ALV grids, trees and table controls. Each one is a thin,
 * named layer over the same COM members the recorder uses, so what a
 * recording does and what these do are the same calls - just readable, and
 * with the waiting the session provides.
 */

/** An ALV grid (`.../cntlGRID1/shellcont/shell`). */
export class SapGrid {
  constructor(
    private readonly sap: SapGuiSession,
    readonly id: string,
  ) {}

  async rowCount(): Promise<number> {
    return Number(await this.sap.get(this.id, 'rowCount'));
  }

  /** The text of one cell: `row` is 0-based, `column` is the column's technical name (e.g. 'MATNR'). */
  async cell(row: number, column: string): Promise<string> {
    return String(await this.sap.call(this.id, 'getCellValue', row, column));
  }

  /** Several columns of every row (up to `max`), as objects - the shape assertions want. */
  async rows(columns: string[], max = 1000): Promise<Array<Record<string, string>>> {
    const count = Math.min(await this.rowCount(), max);
    const rows: Array<Record<string, string>> = [];
    for (let row = 0; row < count; row++) {
      const entry: Record<string, string> = {};
      for (const column of columns) entry[column] = await this.cell(row, column);
      rows.push(entry);
    }
    return rows;
  }

  /** The 0-based row whose `column` equals `value` (trimmed), or -1. */
  async findRow(column: string, value: string): Promise<number> {
    const count = await this.rowCount();
    for (let row = 0; row < count; row++) {
      if ((await this.cell(row, column)).trim() === value.trim()) return row;
    }
    return -1;
  }

  async setCurrentCell(row: number, column: string): Promise<void> {
    await this.sap.set(this.id, 'currentCellRow', row);
    await this.sap.set(this.id, 'currentCellColumn', column);
  }

  async clickCell(row: number, column: string): Promise<void> {
    await this.setCurrentCell(row, column);
    await this.sap.call(this.id, 'clickCurrentCell');
  }

  async doubleClickCell(row: number, column: string): Promise<void> {
    await this.setCurrentCell(row, column);
    await this.sap.call(this.id, 'doubleClickCurrentCell');
  }

  /** Select rows (0-based): selectRows(0, 2, 3). */
  async selectRows(...rows: number[]): Promise<void> {
    await this.sap.set(this.id, 'selectedRows', rows.join(','));
  }

  async pressToolbarButton(buttonId: string): Promise<void> {
    await this.sap.call(this.id, 'pressToolbarButton', buttonId);
  }

  async selectContextMenuItem(functionCode: string): Promise<void> {
    await this.sap.call(this.id, 'selectContextMenuItem', functionCode);
  }
}

/** A tree control: the Easy Access menu, hierarchy lists. Nodes are addressed by their key. */
export class SapTree {
  constructor(
    private readonly sap: SapGuiSession,
    readonly id: string,
  ) {}

  async expandNode(key: string): Promise<void> {
    await this.sap.call(this.id, 'expandNode', key);
  }

  async collapseNode(key: string): Promise<void> {
    await this.sap.call(this.id, 'collapseNode', key);
  }

  async selectNode(key: string): Promise<void> {
    await this.sap.call(this.id, 'selectNode', key);
  }

  /** Double-click: opens the transaction behind a menu entry. */
  async doubleClickNode(key: string): Promise<void> {
    await this.sap.call(this.id, 'doubleClickNode', key);
  }

  async nodeText(key: string): Promise<string> {
    return String(await this.sap.call(this.id, 'getNodeTextByKey', key));
  }

  async selectedNode(): Promise<string> {
    return String(await this.sap.get(this.id, 'selectedNode'));
  }
}

/** A table control (`tblSAPMV45ATCTRL_U_ERF_AUFTRAG`): cells are `<field>[column,row]`. */
export class SapTable {
  constructor(
    private readonly sap: SapGuiSession,
    readonly id: string,
  ) {}

  /** The table control itself, for members the helpers here do not cover (`.set('columns.elementAt(1).width', 18)`). */
  get locator(): SapLocator {
    return this.sap.locator(this.id);
  }

  /** The cell of field `field` (e.g. 'ctxtRV45A-MABNR') at the column/row position shown on screen. */
  cell(field: string, column: number, row: number): SapLocator {
    return this.sap.locator(`${this.id}/${field}[${column},${row}]`);
  }

  /** Scroll so that table row `position` is the first visible one. */
  async scrollTo(position: number): Promise<void> {
    await this.sap.set(this.id, 'verticalScrollbar.position', position);
  }

  async visibleRowCount(): Promise<number> {
    return Number(await this.sap.get(this.id, 'visibleRowCount'));
  }

  async rowCount(): Promise<number> {
    return Number(await this.sap.get(this.id, 'rowCount'));
  }

  async selectRow(row: number, selected = true): Promise<void> {
    await this.sap.set(this.id, `getAbsoluteRow(${row}).selected`, selected as SapGuiValue);
  }
}

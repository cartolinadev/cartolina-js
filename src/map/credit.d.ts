/*
 * credit.d.ts - type the legacy map-credit implementation
 */

import type LegacyMap from './legacy-map';


/**
 * One attribution definition stored by the map credit table.
 */
declare class MapCredit {

    /**
     * @param map owning legacy map
     * @param definition credit metadata
     */
    constructor(map: LegacyMap, definition: MapCredit.Definition);

    getInfo(): MapCredit.Information;

    readonly id: string | number | null;
    readonly notice: string | null;
    readonly copyrighted: boolean;
    readonly url: string | null;
    readonly html: string;
    readonly plain: string;
}


declare namespace MapCredit {

    export type Definition = {
        id?: string | number;
        notice?: string;
        copyrighted?: boolean;
        url?: string;
    };

    export type Information = {
        id: string | number | null;
        notice: string | null;
        html: string;
        plain: string;
    };
}


export default MapCredit;

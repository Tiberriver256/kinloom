declare module '@openhistoricalmap/maplibre-gl-dates' {
  import type { FilterSpecification, Map as MapLibreMap } from 'maplibre-gl';

  export interface DateRange {
    startDate: Date | false;
    startDecimalYear: number | false;
    startISODate: string | false;
    endDate: Date | false;
    endDecimalYear: number | false;
    endISODate: string | false;
  }

  export function filterByDate(map: MapLibreMap, date: string): void;
  export function dateRangeFromDate(date: string | Date): DateRange | undefined;
  export function constrainLayerToDateRange(filter: FilterSpecification | undefined): FilterSpecification;
}

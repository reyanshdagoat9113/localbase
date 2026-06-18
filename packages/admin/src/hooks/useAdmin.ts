import { useQuery } from "@tanstack/react-query";
import { getSchema, getTables } from "@/lib/api";

export function useSchema() {
  return useQuery({ queryKey: ["admin", "schema"], queryFn: getSchema });
}

export function useTables() {
  return useQuery({ queryKey: ["admin", "tables"], queryFn: getTables });
}

import { useState, useEffect, useRef, useCallback } from "react";

import type { IssueRecord } from "../api/types";
import { fetchRecentIssues, searchIssues } from "../api/client";

export interface UseIssueSearchResult {
  query: string;
  setQuery: (q: string) => void;
  issues: IssueRecord[];
  searching: boolean;
  isSearchMode: boolean;
  noResults: boolean;
}

export function useIssueSearch(): UseIssueSearchResult {
  const [query, setQuery] = useState("");
  const [recentIssues, setRecentIssues] = useState<IssueRecord[]>([]);
  const [searchResults, setSearchResults] = useState<IssueRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void fetchRecentIssues(5).then(setRecentIssues);
  }, []);

  const doSearch = useCallback(async (q: string) => {
    setSearching(true);
    try {
      const results = await searchIssues(q);
      setSearchResults(results);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (query.length < 2) {
      setSearchResults([]);
      setSearched(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      void doSearch(query);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, doSearch]);

  const isSearchMode = query.length >= 2;

  return {
    query,
    setQuery,
    issues: isSearchMode ? searchResults : recentIssues,
    searching,
    isSearchMode,
    noResults: isSearchMode && searched && searchResults.length === 0 && !searching,
  };
}

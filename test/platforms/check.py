import json, os, sys
want = json.load(open(sys.argv[1]))
bad = [k for k, v in want.items() if os.environ.get(k) != v]
print("MISMATCH " + ", ".join(bad) if bad else "all %d values identical" % len(want))

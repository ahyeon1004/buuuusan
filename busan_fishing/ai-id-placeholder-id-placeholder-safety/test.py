import json
from server import get_busan_cctv

try:
    result = get_busan_cctv()
    print(json.dumps(result, ensure_ascii=False, indent=2)[:5000])
except Exception as error:
    print("CCTV API 테스트 실패:", repr(error))

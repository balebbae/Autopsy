def test_health(client):
    r = client.get("/v1/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}

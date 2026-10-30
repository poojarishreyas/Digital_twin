from twin_ingestion.phase2.engine import _install_files


def test_config_install_rejects_host_path():
    try:
        _install_files(object(), {"../../host.key": "x"})
    except ValueError:
        return
    raise AssertionError("host path was accepted")


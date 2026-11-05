from setuptools import find_packages, setup

setup(
    name="fleet_reference",
    version="0.1.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/fleet_reference"]),
        ("share/fleet_reference", ["package.xml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Fleet Platform",
    maintainer_email="maintainers@example.invalid",
    description="参照ROS機体と制御可能な障害シナリオ",
    license="MIT",
    tests_require=["pytest"],
    entry_points={"console_scripts": ["serve = fleet_reference.cli:main"]},
)
